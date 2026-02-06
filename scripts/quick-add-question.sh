#!/bin/bash

# Quick OA Question Management Script
# Run with: ./quick-add-question.sh

cd "$(dirname "$0")" || exit 1

echo ""
echo "🚀 === OA Question Management Tool ==="
echo ""
echo "Choose an option:"
echo "1. Add question interactively (CLI)"
echo "2. Import questions from JSON file"
echo "3. View question template"
echo "4. Exit"
echo ""
read -p "Enter choice (1-4): " choice

case $choice in
    1)
        echo ""
        echo "Starting interactive question addition..."
        echo ""
        node addQuestion.js
        ;;
    2)
        read -p "Enter JSON file path: " filepath
        if [ -z "$filepath" ]; then
            echo "❌ No file path provided"
            exit 1
        fi
        if [ ! -f "$filepath" ]; then
            echo "❌ File not found: $filepath"
            exit 1
        fi
        node addQuestionFromJSON.js "$filepath"
        ;;
    3)
        if command -v cat &> /dev/null; then
            cat question-template.json
        else
            echo "❌ Cannot view file"
        fi
        ;;
    4)
        echo "👋 Goodbye!"
        exit 0
        ;;
    *)
        echo "❌ Invalid choice"
        exit 1
        ;;
esac
