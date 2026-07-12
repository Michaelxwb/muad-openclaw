#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  exit 2
fi

exec session-manager get-state --platform "$1"
