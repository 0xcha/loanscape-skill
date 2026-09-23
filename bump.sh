#!/bin/sh
# Bump the plugin version (patch by default) so `claude plugin update lotus@lotus-labs` picks up the change.
#   ./bump.sh [major|minor|patch]
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
PART="${1:-patch}"
python3 - "$PART" "$HERE" <<'PY'
import json,sys
part,here=sys.argv[1],sys.argv[2]
pj=f"{here}/plugins/lotus/.claude-plugin/plugin.json"; mj=f"{here}/.claude-plugin/marketplace.json"
d=json.load(open(pj)); M,m,p=[int(x) for x in d["version"].split(".")]
M,m,p={"major":(M+1,0,0),"minor":(M,m+1,0),"patch":(M,m,p+1)}[part]
v=f"{M}.{m}.{p}"; d["version"]=v; json.dump(d,open(pj,"w"),indent=2)
k=json.load(open(mj)); k["plugins"][0]["version"]=v; json.dump(k,open(mj,"w"),indent=2)
print(v)
PY
