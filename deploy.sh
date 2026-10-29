#!/usr/bin/env bash
# `deno task deploy`: uploads the Build Output (`deno task build:cf`) as the production Worker.
#
# cloudflare.config.ts is the Worker's configuration. When the Worker was last changed on
# Cloudflare's side — in the dashboard, say by setting a secret — `cf deploy` asks before
# overriding that, and when it is not at a terminal (any build) it aborts instead, with no flag to
# override. So it runs in a pseudo-terminal with CI=false and is answered Yes, as at a terminal;
# the diff it overrides is printed. When nothing differs, nothing is asked and the answer goes
# unread.
set -euo pipefail

answer=$(mktemp -u)
mkfifo "$answer"
trap 'rm -f "$answer"' EXIT

# The answer waits in the terminal until cf asks; the fifo keeps the terminal's input open until
# the deploy is done.
CI=false script -qefc "deno run -A npm:cf deploy --prebuilt" /dev/null < "$answer" &
deploy=$!
exec 3> "$answer"
printf 'y\r' >&3
wait "$deploy"
