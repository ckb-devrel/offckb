#!/bin/bash
set -e

# Create a unique test project name to avoid conflicts
TEST_PROJECT_NAME="test-project-$$"
TEST_PROJECT_DIR="/tmp/${TEST_PROJECT_NAME}"

echo "Starting offckb create integration test..."
echo "Test project: ${TEST_PROJECT_NAME}"

# Cleanup function
cleanup() {
  echo "Cleaning up..."
  
  # Stop the node if it's still running
  if [ ! -z "$NODE_PID" ]; then
    echo "Stopping node (PID: $NODE_PID)..."
    kill $NODE_PID 2>/dev/null || true
    wait $NODE_PID 2>/dev/null || true
  fi
  
  # Remove test project directory
  if [ -d "$TEST_PROJECT_DIR" ]; then
    echo "Removing test project directory..."
    rm -rf "$TEST_PROJECT_DIR"
  fi
  
  echo "Cleanup complete."
}

# Set up trap to cleanup on exit
trap cleanup EXIT INT TERM

# Start the node in the background
echo "Starting devnet node..."
pnpm start node &
NODE_PID=$!
echo "Node started with PID: $NODE_PID"

# Wait for the node to be ready (max 60 seconds)
echo "Waiting for node to start..."
for i in {1..60}; do
  if curl -s -f -X POST -H 'content-type: application/json' \
    -d '{"id":2,"jsonrpc":"2.0","method":"get_tip_block_number","params":[]}' \
    http://127.0.0.1:28114 > /dev/null 2>&1; then
    echo "✓ Node is ready!"
    break
  fi
  if [ $i -eq 60 ]; then
    echo "✗ Timeout waiting for node to start"
    exit 1
  fi
  sleep 1
done

# Test the RPC endpoint to verify node is working
echo "Verifying node is responding..."
RESPONSE=$(echo '{"id":2,"jsonrpc":"2.0","method":"get_tip_block_number","params":[]}' | \
  tr -d '\n' | \
  curl -s -H 'content-type: application/json' -d @- http://127.0.0.1:28114)

if echo "$RESPONSE" | grep -q '"result"'; then
  echo "✓ Node is responding to RPC calls"
else
  echo "✗ Node is not responding correctly"
  echo "Response: $RESPONSE"
  exit 1
fi

# Install offckb since create test need it
echo ""
echo "Installing offckb CLI tool..."
# Use the local build but install it globally for better compatibility
OFFCKB_CLI_PATH="$(pwd)/build/index.js"
if [ ! -f "$OFFCKB_CLI_PATH" ]; then
  echo "✗ Local build not found at $OFFCKB_CLI_PATH"
  echo "Please run 'pnpm build' first"
  exit 1
fi

# Pack and install the local build globally
echo "Packing local build..."
pnpm pack --pack-destination /tmp
PACKAGE_FILE=$(ls /tmp/@offckb-cli-*.tgz)
echo "Installing local package globally: $PACKAGE_FILE"
npm install -g "$PACKAGE_FILE"

echo "✓ Local offckb CLI installed globally"

# Create test project with non-interactive mode
echo ""
echo "Creating test project with offckb create..."
# Create project with explicit options:
# - --no-interactive: Skip all interactive prompts
# - --no-git: Skip git initialization (not needed for CI)
# - --no-install: Skip automatic dependency installation (we'll do it explicitly)
# - -l typescript: Use TypeScript language
# - -c hello-world: Name the first contract 'hello-world'
CONTRACT_NAME="hello-world"
offckb create "$TEST_PROJECT_DIR" \
  --no-interactive \
  --no-git \
  --no-install \
  -l typescript \
  -c "$CONTRACT_NAME"

# Check if project was created
if [ ! -d "$TEST_PROJECT_DIR" ]; then
  echo "✗ Failed to create project directory"
  exit 1
fi

echo "✓ Project directory created"

# Check for essential files
echo "Checking for essential project files..."
ESSENTIAL_FILES=(
  "package.json"
  "README.md"
  ".env"
  ".env.example"
  ".gitignore"
  "jest.config.cjs"
  "tsconfig.json"
  "scripts/build-all.js"
  "scripts/deploy.js"
  "contracts/hello-world/src/index.ts"
  "tests/hello-world.mock.test.ts"
  "tests/hello-world.devnet.test.ts"
  "deployment/scripts.json"
  "deployment/system-scripts.json"
)

for file in "${ESSENTIAL_FILES[@]}"; do
  if [ ! -f "$TEST_PROJECT_DIR/$file" ]; then
    echo "✗ Missing essential file: $file"
    exit 1
  fi
done

echo "✓ All essential files are present"

# Install dependencies explicitly to make test deterministic
echo ""
echo "Installing dependencies..."
cd "$TEST_PROJECT_DIR"
# Note: First try with frozen-lockfile, but fall back to regular install
# since the newly created project might not have a lock file initially
if pnpm install --frozen-lockfile 2>/dev/null; then
  echo "✓ Dependencies installed with frozen lockfile"
else
  echo "⚠ Frozen lockfile not available, installing with regular mode..."
  pnpm install
  echo "✓ Dependencies installed"
fi

# Build the project
echo ""
echo "Building the project..."
cd "$TEST_PROJECT_DIR"
pnpm run build

if [ ! -d "$TEST_PROJECT_DIR/dist" ]; then
  echo "✗ Build failed - dist directory not created"
  exit 1
fi

# Check if the contract binary was built
if [ ! -f "$TEST_PROJECT_DIR/dist/hello-world.js" ]; then
  echo "✗ Build failed - contract binary not created"
  exit 1
fi

echo "✓ Project built successfully"

# Deploy the project
echo ""
echo "Deploying the project..."
cd "$TEST_PROJECT_DIR"
pnpm run deploy -- --network devnet --yes

# Check if deployment artifacts were created
if [ ! -f "$TEST_PROJECT_DIR/deployment/scripts.json" ]; then
  echo "✗ Deploy failed - deployment record not created"
  exit 1
fi

echo "✓ Project deployed successfully"

# Verify deployment record contains expected data
echo ""
echo "Verifying deployment record..."
DEPLOY_RECORD=$(cat "$TEST_PROJECT_DIR/deployment/scripts.json")

if ! echo "$DEPLOY_RECORD" | grep -q '"devnet"'; then
  echo "✗ Deployment record is missing devnet section"
  exit 1
fi

if ! echo "$DEPLOY_RECORD" | grep -q "\"${CONTRACT_NAME}.bc\""; then
  echo "✗ Deployment record is missing ${CONTRACT_NAME}.bc contract"
  exit 1
fi

if ! echo "$DEPLOY_RECORD" | grep -q '"txHash"'; then
  echo "✗ Deployment record is missing txHash"
  exit 1
fi

echo "✓ Deployment record is valid"

# Run a quick test to make sure the test framework works
echo ""
echo "Running mock tests..."
cd "$TEST_PROJECT_DIR"
pnpm run test

echo "✓ All tests passed"

echo ""
echo "========================================"
echo "✓ All offckb create integration tests passed!"
echo "========================================"

exit 0
