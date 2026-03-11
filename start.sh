#!/bin/bash
echo "Starting ShareSecure Local Edition..."

echo "Checking for updates..."
git pull

echo "Installing dependencies if needed..."
npm install

echo "Starting the server..."
npm start
