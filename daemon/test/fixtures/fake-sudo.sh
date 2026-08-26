#!/bin/bash
set -euo pipefail
case ${1:-} in
  -n) [[ ${2:-} == true ]] && exit 0 ;;
  -v) exit 0 ;;
  -u)
    shift 2
    if [[ ${1:-} == env ]]; then shift; while [[ ${1:-} == *=* ]]; do export "$1"; shift; done; fi
    exec "$@"
    ;;
  install) [[ ${2:-} == -d ]] && exit 0 ;;
  /usr/sbin/visudo|visudo) exit 0 ;;
esac
exec "$@"
