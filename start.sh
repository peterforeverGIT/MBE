cat > start.sh << 'EOF'
#!/data/data/com.termux/files/usr/bin/bash

SESSION="markovbot"

cd "$(dirname "$0")"

# create session if it doesn't exist
tmux has-session -t $SESSION 2>/dev/null

if [ $? != 0 ]; then
  tmux new-session -d -s $SESSION "node index.js"
  echo "Started MarkovBot in tmux session: $SESSION"
else
  echo "Session already running: $SESSION"
fi

echo "Attach with: tmux attach -t $SESSION"
EOF
