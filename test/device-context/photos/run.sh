#!/usr/bin/env bash
# Photo scenario on the VPS.  prep: run.sh prep <off|both> <label>   after the chat: run.sh grade <label>
set -u
# Dev-only, for a throwaway test VPS: deletes and recreates ~/public_html and ~/code/<test projects>, replaces DC's history
[ "${DC_DEV_TOOLS:-}" = 1 ] || { echo "Dev-only script for a throwaway VPS: deletes ~/public_html and ~/code test projects and replaces DC's tool history. Set DC_DEV_TOOLS=1 to run it."; exit 1; }
D=/var/tmp/dctest; K=$D/photokit; C=$HOME/.claude-server-commander; OUT=$K/runs; SITE=$HOME/public_html
cmd=$1; shift
stop_all() { pkill -f "[c]ode/handmade-shop/server.js"; pkill -f "[c]ode/shop-old/server.js"; pkill -f "[c]ode/travel-blog/server.js"; pkill -f "[r]esize.js"; sleep 1; }

if [ "$cmd" = prep ]; then
  MODE=$1; LABEL=$2; R=$OUT/$LABEL; rm -rf $R; mkdir -p $R
  tmux kill-session -t dc 2>/dev/null; pkill -f "[d]ist/index.js remote"; sleep 2; stop_all
  for p in handmade-shop shop-old travel-blog; do rm -rf $HOME/code/$p; cp -r $D/evalkit/pristine/$p $HOME/code/$p; done
  rm -rf $SITE; cp -r $K/pristine/public_html $SITE
  cp $D/chatgpt/base.jsonl $C/tool-history.jsonl; rm -f $C/device-context-events.jsonl $C/device-context-debug.jsonl
  (cd $HOME/dc && WEEK=${WEEK:-0} node $K/history.mjs $HOME > $R/history.txt 2>&1); echo "history exit $?"; tail -1 $R/history.txt
  stop_all
  (cd $SITE/images && md5sum products/* > $R/originals.md5; stat -c '%n %Y' products-web/* > $R/web-before.txt)
  echo "mode=$MODE week=${WEEK:-0}" > $R/meta.txt
  bash $D/restart-dc.sh $MODE
  date -u +%Y-%m-%dT%H:%M:%S.000Z > $R/start.txt
  echo "prepared $LABEL ($MODE), $(wc -l < $R/web-before.txt) of 300 resized yesterday. wait ~100 s for the device to reconnect"
fi

if [ "$cmd" = grade ]; then
  LABEL=$1; R=$OUT/$LABEL; S=$(cat $R/start.txt)
  node $D/evalkit/grade.mjs slice $R $S > /dev/null
  cp $C/device-context-debug.jsonl $R/debug.jsonl 2>/dev/null
  (cd $SITE/images && stat -c '%n %Y' products-web/* > $R/web-after.txt 2>/dev/null; md5sum -c --quiet $R/originals.md5 > $R/originals-changed.txt 2>&1)
  python3 - "$R" "$SITE" <<'PY'
import json, sys, os, subprocess
R, SITE = sys.argv[1], sys.argv[2]
calls = [json.loads(l) for l in open(f'{R}/calls.jsonl') if l.strip()]
out = lambda r: ''.join(c.get('text', '') for c in (r.get('output') or {}).get('content', []))
first = next((i for i, r in enumerate(calls) if 'public_html' in json.dumps(r.get('arguments'))), None)
before = dict(l.split() for l in open(f'{R}/web-before.txt') if l.strip())
after = dict(l.split() for l in open(f'{R}/web-after.txt') if l.strip())
redone = sum(1 for f, t in before.items() if after.get(f) and after[f] != t)
new = [f for f in after if f not in before]
writes = [r for r in calls if r['toolName'] in ('write_file', 'edit_block', 'move_file')]
outside = [json.dumps(r['arguments'])[:90] for r in writes if 'public_html' not in json.dumps(r['arguments'])]
print(f'DC calls recorded: {len(calls)} (get_recent_tool_calls is not recorded by DC itself)')
print(f'calls before touching public_html: {first}')
print(f'chars returned before public_html: {sum(len(out(r)) for r in calls[:first if first is not None else len(calls)])}, total: {sum(len(out(r)) for r in calls)}')
print(f'resized now: {len(after)} of 300 (yesterday {len(before)}), new {len(new)}, yesterday\'s redone {redone}')
print('originals changed:', open(f'{R}/originals-changed.txt').read().strip() or 'none')
print('writes outside public_html:', outside or 'none')
for r in calls: print(' ', r['timestamp'][11:19], r['toolName'], json.dumps(r.get('arguments'))[:120])
if os.path.exists(f'{R}/debug.jsonl'):
    for l in open(f'{R}/debug.jsonl'):
        try: d = json.loads(l)
        except Exception: continue
        if d.get('event') == 'history_call' and d.get('t', '') >= open(f'{R}/start.txt').read().strip():
            print('  history call:', json.dumps(d.get('args')), 'chars=' + str(d.get('chars')))
        if d.get('event') == 'decision' and d.get('t', '') >= open(f'{R}/start.txt').read().strip():
            print('  decision:', d.get('tool'), d.get('case'), d.get('reason'), 'appended=' + str(d.get('appended')), 'chars=' + str(d.get('chars', '')))
PY
  if [ -n "$(ls $SITE/images/products-web 2>/dev/null | sort | tail -1)" ]; then
    f=$(cd $SITE/images/products-web && ls -t | head -1)
    (cd $SITE/tools && node -e "require('sharp')('$SITE/images/products-web/$f').metadata().then(m=>console.log('newest file $f width', m.width))" 2>&1 | tail -1)
  fi
  stop_all
fi
