#!/usr/bin/env node
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createPipeline } from '../runtime/pipeline.mjs';
import { createDecisionService } from '../runtime/jev/index.mjs';
import { diagnosticArtifactId } from '../runtime/daemon/diagnostics.mjs';

// Synthetic code only. No tools execute this application, and the probe never
// opens the user's project or reads a Claude transcript.
const files = {
  'src/server.ts': `import express from "express";
export function startServer() {
  const app = express();
  app.listen(3000);
  return app;
}
`,
  'src/index.ts': `import { startServer } from "./server.js";
export function main() { return startServer(); }
`,
  'src/auth.ts': `export function requireAuth(request, response, next) {
  if (!request.session?.user) return response.status(401).end();
  return next();
}
`,
  'src/db.ts': `import Database from "better-sqlite3";
const database = new Database("greetings.db");
export function saveGreeting(body) {
  return database.prepare("INSERT INTO greetings (body) VALUES (?)").run(body);
}
`,
  'src/cache.ts': `import Redis from "ioredis";
const redis = new Redis(process.env.REDIS_URL);
export function getCachedGreeting(id) { return redis.get(id); }
export function cacheGreeting(id, body) { return redis.set(id, body); }
`,
  'src/imageStorage.ts': `import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
const imageClient = new S3Client({});
export function storeImage(body) {
  return imageClient.send(new PutObjectCommand({
    Bucket: process.env.IMAGE_BUCKET, Key: "greeting.png", Body: body
  }));
}
`,
  'public/app.js': `export async function loadGreetings() {
  const response = await fetch("/api/greetings");
  return response.json();
}
`,
};

export async function evaluateDiscovery({ apiKey, fetchImpl = globalThis.fetch } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'graphlin-discovery-eval-')));
  const records = [];
  let requests = 0;
  const service = createDecisionService({
    apiKey,
    // Match the daemon's background workflow budget, including both Jev stages.
    limits: { eventDeadlineMs: 5000 },
    fetchImpl: async (url, options) => {
      if (++requests > 40 || String(url) !== 'https://api.typesafe.ai/v1/systemone') {
        throw new Error('DISCOVERY_EVALUATION_REQUEST_LIMIT');
      }
      return fetchImpl(url, options);
    },
  });
  let pipeline;
  try {
    for (const [filename, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
      await writeFile(path.join(root, filename), source);
    }
    pipeline = createPipeline({
      projectRoot: root, policy: { transmitSource: true, displayEvidence: true },
      classificationDeadlineMs: 5000,
      decisionService: service, onDiagnostic: record => records.push(record),
    });
    // Reproduce a daemon that already knows the worktree before a fresh session.
    await pipeline.reconcile();
    const session = { session_id: 'orientation-probe', cwd: root };
    const start = performance.now();
    await pipeline.ingest({ ...session, hook_event_name: 'SessionStart' });
    await pipeline.ingest({
      ...session, hook_event_name: 'UserPromptSubmit', prompt: 'Orient yourself in this project.',
    });
    await pipeline.ingest({
      ...session, hook_event_name: 'PostToolUse', tool_use_id: 'list-source',
      tool_name: 'Bash', tool_input: { command: `find "${root}/src" "${root}/public" -type f` },
      tool_response: {
        stdout: Object.keys(files).map(filename => path.join(root, filename)).join('\n'),
        stderr: '', interrupted: false, isImage: false,
      },
    });
    await Promise.all(Object.entries(files).map(([filename, content], index) => pipeline.ingest({
      ...session, hook_event_name: 'PostToolUse', tool_use_id: `read-${index}`,
      tool_name: 'Read', tool_input: { file_path: path.join(root, filename) },
      tool_response: { type: 'text', file: {
        filePath: path.join(root, filename), content, startLine: 1,
        numLines: content.trimEnd().split('\n').length,
        totalLines: content.trimEnd().split('\n').length,
      } },
    })));
    const captureMs = Math.round(performance.now() - start);
    await pipeline.whenIdle();
    const state = pipeline.getState();
    const coverage = Object.keys(files).map(filename => {
      const artifactId = diagnosticArtifactId(root, filename);
      const nodes = state.graph.nodes.filter(node => node.sourceRefs.some(ref => ref.artifactId === artifactId));
      const decisions = records.filter(record => record.stage === 'classification' &&
        !['started', 'queued'].includes(record.status) &&
        record.artifacts?.some(artifact => artifact.artifactId === artifactId));
      return { file: filename, nodes: nodes.map(node => node.label),
        decisions: decisions.map(record => ({ status: record.status, reason: record.reason })) };
    });
    const missing = coverage.filter(file => !file.nodes.length).map(file => file.file);
    return {
      mode: 'live-synthetic', passed: missing.length === 0,
      captureMs, totalMs: Math.round(performance.now() - start), requests,
      files: coverage, missing, nodes: state.graph.nodes.length, edges: state.graph.edges.length,
      pending: state.status.pending, dropped: state.status.dropped,
      verifiedClaims: [...state.graph.nodes, ...state.graph.edges].filter(item => item.evidenceState === 'verified').length,
      maximumQueueWaitMs: Math.max(0, ...records.map(record => record.diagnostics?.queue?.waitMs ?? 0)),
    };
  } finally {
    if (pipeline) await pipeline.close();
    else service.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  if (!process.env.TYPESAFE_API_KEY) {
    try { process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url))); } catch {}
  }
  if (!process.env.TYPESAFE_API_KEY) {
    console.error('Set TYPESAFE_API_KEY or add it to .env.local to run the synthetic discovery probe.');
    process.exitCode = 2;
    return;
  }
  const report = await evaluateDiscovery({ apiKey: process.env.TYPESAFE_API_KEY });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed || report.verifiedClaims !== 0 || report.pending !== 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error('The synthetic discovery probe failed. No credentials or source were logged.');
    process.exitCode = 1;
  });
}
