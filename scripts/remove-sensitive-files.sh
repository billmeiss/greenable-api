#!/bin/bash

# This script removes sensitive files from Git history
# Usage: ./scripts/remove-sensitive-files.sh

echo "Removing sensitive files from Git history..."

# Create a backup branch
git checkout -b backup-before-removing-sensitive-files || {
  echo "Backup branch already exists, continuing..."
}
git checkout main

# Check if BFG is installed
if ! command -v bfg &> /dev/null; then
  echo "BFG Repo-Cleaner is not installed. Installing it now..."
  
  # Check if Java is installed
  if ! command -v java &> /dev/null; then
    echo "Java is required to run BFG. Please install Java first."
    exit 1
  fi
  
  # Download BFG
  curl -L -o bfg.jar https://repo1.maven.org/maven2/com/madgag/bfg/1.14.0/bfg-1.14.0.jar
  echo "BFG downloaded as bfg.jar"
  
  # Create a simple wrapper script
  echo '#!/bin/bash
java -jar "'$PWD'/bfg.jar" "$@"' > bfg
  chmod +x bfg
  echo "Created BFG wrapper script"
  
  BFG_CMD="./bfg"
else
  BFG_CMD="bfg"
fi

# Make sure all current changes are committed
if [[ -n $(git status --porcelain) ]]; then
  echo "You have uncommitted changes. Please commit or stash them before proceeding."
  exit 1
fi

# Create a fresh clone for BFG to work with
echo "Creating a fresh clone of the repository..."
cd ..
git clone --mirror file://$PWD/greenable-api greenable-api.git
cd greenable-api.git

# Use BFG to remove the sensitive files
echo "Removing sensitive files from repository history..."
$BFG_CMD --delete-files credentials.json
$BFG_CMD --delete-files credentials.json.bak
$BFG_CMD --delete-files token.json

# Clean up the repository
git reflog expire --expire=now --all && git gc --prune=now --aggressive

# Go back to original repo
cd ../greenable-api

# Push the changes to the remote repository
echo "Repository cleaned. You can now push it to GitHub."
echo "WARNING: This will rewrite Git history. Make sure all team members are aware of this change."
echo "After this, team members will need to clone the repository again or run:"
echo "git fetch --all && git reset --hard origin/main"
echo ""
read -p "Do you want to push the cleaned repository now? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  # Push with force to overwrite history
  git push origin main --force
  echo "Sensitive files have been removed from Git history and changes pushed to GitHub."
  echo "Please make sure your credentials are stored safely in environment variables."
else
  echo "Operation cancelled. You can push the changes manually with:"
  echo "git push origin main --force"
fi 