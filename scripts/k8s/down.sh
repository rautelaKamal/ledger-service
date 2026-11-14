#!/usr/bin/env bash
# Delete the kind cluster. Everything in it (including the database volume) is gone.
source "$(dirname "$0")/lib.sh"
need kind
kind delete cluster --name "$CLUSTER"
