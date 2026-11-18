#!/usr/bin/env bash
# Validate the manifests WITHOUT a cluster (CI runs this on every push):
#   1. kubectl kustomize renders the base and every overlay (catches bad
#      references, missing files, malformed patches)
#   2. kubeconform checks every rendered object against the Kubernetes API
#      schemas, strictly: unknown fields are errors, not silently ignored
#   3. no Secret manifest is tracked in git
#
#   scripts/k8s/validate.sh          (needs kubectl and kubeconform on PATH,
#                                     or KUBECONFORM=/path/to/kubeconform)
set -euo pipefail
cd "$(dirname "$0")/../.."
KUBECONFORM=${KUBECONFORM:-kubeconform}
command -v kubectl >/dev/null || { echo "kubectl is not installed"; exit 1; }
command -v "$KUBECONFORM" >/dev/null || { echo "kubeconform is not installed (https://github.com/yannh/kubeconform)"; exit 1; }
# The schema version to validate against. The kind node runs 1.37; the preStop
# `sleep` action needs 1.30+. Schemas exist for released versions only.
K8S_VERSION=${K8S_SCHEMA_VERSION:-1.33.0}

check() {
  echo "-- $1"
  kubectl kustomize "$1" | "$KUBECONFORM" -strict -summary -kubernetes-version "$K8S_VERSION" -schema-location default -
}
check k8s/base
check k8s/overlays/kind
check k8s/overlays/kind/seed
check k8s/overlays/kind/seed-demo
echo "-- k8s/tools/k6/job.yaml"
"$KUBECONFORM" -strict -summary -kubernetes-version "$K8S_VERSION" k8s/tools/k6/job.yaml

echo "-- no Secret manifests in git"
if git ls-files k8s | xargs grep -l '^kind: Secret' 2>/dev/null; then
  echo "a Secret manifest is tracked in git; Secrets come from scripts/k8s/secrets.sh"; exit 1
fi
echo "ok"
