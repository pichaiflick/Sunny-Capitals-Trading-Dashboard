#!/bin/bash
if ! command -v node &> /dev/null; then
    echo "Node.js is not installed."
    echo "Please download it from https://nodejs.org (LTS version)"
    exit 1
fi
while true; do
    echo "Starting Sunny Capitals..."
    node server.js
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 0 ]; then
        echo "Restarting with new config..."
        sleep 1
    else
        echo "Server stopped."
        break
    fi
done
