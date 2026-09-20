// Actual B measurements from .graphlin/jev-live-evaluation-kinds-1789855883436.json.
// Report SHA-256: 664031652233b65152ee6974a45d4a4c659986cda0d6a6274106c4f1520549cc.
// Unlisted choices were exactly zero. Offline replay verifies that these v4
// failures remain failures; it is not a prediction of v5 model behavior.
export const v4KindFailures = [
  {
    "caseId": "kind-configuration",
    "repeat": 1,
    "status": "accepted",
    "judgments": [
      {
        "name": "poolOptions",
        "expectedRole": "configuration",
        "support": 0.96,
        "choice": "configuration",
        "confidence": 0.92,
        "probabilities": {
          "module": 0.07,
          "configuration": 0.93
        }
      },
      {
        "name": "db",
        "expectedRole": "datastore",
        "support": 0.94,
        "choice": "module",
        "confidence": 0.59,
        "probabilities": {
          "client": 0.06,
          "datastore": 0.19,
          "module": 0.63,
          "class": 0.12
        }
      }
    ]
  },
  {
    "caseId": "kind-package-alias",
    "repeat": 1,
    "status": "accepted",
    "judgments": [
      {
        "name": "database",
        "expectedRole": "package",
        "support": 0.93,
        "choice": "module",
        "confidence": 0.77,
        "probabilities": {
          "client": 0.01,
          "datastore": 0.04,
          "module": 0.8,
          "package": 0.15
        }
      }
    ]
  },
  {
    "caseId": "kind-member-alias",
    "repeat": 1,
    "status": "abstained",
    "judgments": [
      {
        "name": "Store",
        "expectedRole": "module",
        "support": 0.94,
        "choice": "module",
        "confidence": 0.76,
        "probabilities": {
          "client": 0.01,
          "datastore": 0.09,
          "module": 0.79,
          "class": 0.11
        }
      }
    ]
  },
  {
    "caseId": "kind-plain-data",
    "repeat": 1,
    "status": "abstained",
    "judgments": [
      {
        "name": "event",
        "expectedRole": "module",
        "support": 0.94,
        "choice": "module",
        "confidence": 0.71,
        "probabilities": {
          "module": 0.74,
          "event": 0.24,
          "configuration": 0.01,
          "unknown": 0.01
        }
      }
    ]
  },
  {
    "caseId": "kind-configuration",
    "repeat": 2,
    "status": "accepted",
    "judgments": [
      {
        "name": "poolOptions",
        "expectedRole": "configuration",
        "support": 0.96,
        "choice": "configuration",
        "confidence": 0.89,
        "probabilities": {
          "module": 0.09,
          "configuration": 0.9,
          "unknown": 0.01
        }
      },
      {
        "name": "db",
        "expectedRole": "datastore",
        "support": 0.94,
        "choice": "module",
        "confidence": 0.61,
        "probabilities": {
          "client": 0.07,
          "datastore": 0.2,
          "module": 0.65,
          "class": 0.08
        }
      }
    ]
  },
  {
    "caseId": "kind-package-alias",
    "repeat": 2,
    "status": "abstained",
    "judgments": [
      {
        "name": "database",
        "expectedRole": "package",
        "support": 0.92,
        "choice": "module",
        "confidence": 0.75,
        "probabilities": {
          "client": 0.01,
          "datastore": 0.06,
          "module": 0.78,
          "package": 0.15
        }
      }
    ]
  },
  {
    "caseId": "kind-member-alias",
    "repeat": 2,
    "status": "abstained",
    "judgments": [
      {
        "name": "Store",
        "expectedRole": "module",
        "support": 0.95,
        "choice": "module",
        "confidence": 0.72,
        "probabilities": {
          "client": 0.01,
          "datastore": 0.11,
          "module": 0.75,
          "class": 0.13
        }
      }
    ]
  },
  {
    "caseId": "kind-plain-data",
    "repeat": 2,
    "status": "abstained",
    "judgments": [
      {
        "name": "event",
        "expectedRole": "module",
        "support": 0.94,
        "choice": "module",
        "confidence": 0.75,
        "probabilities": {
          "module": 0.78,
          "event": 0.19,
          "configuration": 0.02,
          "unknown": 0.01
        }
      }
    ]
  }
];
