#!/bin/sh
# SW-1131: CI starts with no ~/.werkmeister, so one after the tests is a test writing the runner's real home.
# The listing names the writer (locks/, scheduler/, metrics/ …).
[ -e "$HOME/.werkmeister" ] || exit 0
echo "::error::a test wrote $HOME/.werkmeister; point it at a temp HOME"
find "$HOME/.werkmeister" -ls
exit 1
