#!/usr/bin/env bash
# Double-click this in Finder to open the Minami Bento knowledge base.
#
# Runs the standalone KB server (public/kb/serve.mjs) and opens a browser. Independent of the
# dashboard — this works whether or not :3000 is up, which is the point: the docs are most useful
# when something else is broken.
#
# Close the Terminal window (or ctrl-c) to stop it.
cd "$(dirname "$0")" || exit 1
exec node public/kb/serve.mjs
