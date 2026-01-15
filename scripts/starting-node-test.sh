#!/bin/bash
set -e

# Start the node in the background
pnpm start node &
NODE_PID=$!

# Wait for the node to be ready (max 60 seconds)
echo "Waiting for node to start..."
for i in {1..60}; do
  if curl -s -f -X POST -H 'content-type: application/json' \
    -d '{"id":2,"jsonrpc":"2.0","method":"get_tip_block_number","params":[]}' \
    http://127.0.0.1:28114 > /dev/null 2>&1; then
    echo "Node is ready!"
    break
  fi
  if [ $i -eq 60 ]; then
    echo "Timeout waiting for node to start"
    kill $NODE_PID 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

# Test the RPC endpoint
echo "Testing get_tip_block_number RPC call..."
RESPONSE=$(echo '{"id":2,"jsonrpc":"2.0","method":"get_tip_block_number","params":[]}' | \
  tr -d '\n' | \
  curl -s -H 'content-type: application/json' -d @- http://127.0.0.1:28114)

echo "Response: $RESPONSE"

# Check if the response contains a result
if echo "$RESPONSE" | grep -q '"result"'; then
  echo "✓ Successfully retrieved tip block number"
  # Stop the node
  kill $NODE_PID 2>/dev/null || true
  exit 0
else
  echo "✗ Failed to get tip block number"
  echo "Response: $RESPONSE"
  # Stop the node
  kill $NODE_PID 2>/dev/null || true
  exit 1
fi
