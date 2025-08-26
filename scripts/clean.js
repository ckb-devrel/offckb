#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

console.log('🧹 Cleaning build artifacts...\n');

const dirsToClean = ['dist', 'build', 'target'];

function removeDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    const stats = fs.statSync(dirPath);
    if (stats.isDirectory()) {
      // Calculate directory size before removing
      let totalSize = 0;
      const calculateSize = (dir) => {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const itemPath = path.join(dir, item);
          const itemStats = fs.statSync(itemPath);
          if (itemStats.isDirectory()) {
            calculateSize(itemPath);
          } else {
            totalSize += itemStats.size;
          }
        }
      };
      
      try {
        calculateSize(dirPath);
        fs.rmSync(dirPath, { recursive: true, force: true });
        console.log(`  ✅ Removed ${dirPath}/ (${(totalSize / 1024 / 1024).toFixed(2)} MB)`);
      } catch (error) {
        console.log(`  ❌ Failed to remove ${dirPath}/: ${error.message}`);
      }
    }
  } else {
    console.log(`  ℹ️  ${dirPath}/ (already clean)`);
  }
}

for (const dir of dirsToClean) {
  removeDir(dir);
}

console.log('\n🎉 Clean completed!');
