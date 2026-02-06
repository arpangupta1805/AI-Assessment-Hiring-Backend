# OA Question Management Tools

## Overview

This directory contains tools to manage OA (Online Assessment) questions in the database. You have multiple ways to add questions:

1. **Interactive CLI** - Guided prompt-based question entry
2. **JSON Import** - Bulk import from JSON file
3. **Quick Menu** - Shell script for easy access

## Setup

All tools require MongoDB connection. Set your connection string in `.env`:

```env
MONGODB_URI=mongodb://localhost:27017/oa_interview
```

## Method 1: Interactive CLI (Recommended for Single Questions)

### Command
```bash
node addQuestion.js
```

### Flow
1. You'll be prompted for each field one by one
2. For test cases, use format: `input | output`
3. Multiple test cases on separate lines
4. After adding, choose to add another or exit

### Example Input
```
Question ID: Q001
Question Description: Write a function to find factorial
Difficulty Level: easy
Role: SDE 1
Company Name: Google
Estimated Time: 15
Constraints: 1 <= n <= 20, result fits in integer
How to Approach: Use iteration or recursion
Solution Code: def factorial(n): return 1 if n <= 1 else n * factorial(n-1)
Optimal Solution Code: (same or better version)

Visible Test Cases:
5 | 120
0 | 1

Hidden Test Cases:
10 | 3628800

Edge Test Cases:
20 | 2432902008176640000
```

## Method 2: JSON Import (Recommended for Bulk Questions)

### Command
```bash
node addQuestionFromJSON.js path/to/questions.json
```

### JSON Format

```json
{
  "questions": [
    {
      "questionid": "Q001",
      "questiontxt": "Question description",
      "difficulty": "easy|medium|hard|expert",
      "role": "SDE 1|SDE 2|SDE 3",
      "company": "Company Name",
      "estimated_time": 15,
      "constraints": ["constraint1", "constraint2"],
      "howtoapproach": "Approach explanation",
      "optimal_solution": "Optimal code solution",
      "visible_testcases": {
        "case_1": { "input": "5", "output": "120" },
        "case_2": { "input": "0", "output": "1" }
      },
      "hidden_testcases": {
        "case_3": { "input": "10", "output": "3628800" }
      },
      "edge_testcases": {
        "case_4": { "input": "20", "output": "..." }
      }
    }
  ]
}
```

### Features
- ✅ Bulk import multiple questions
- ✅ Automatic duplicate detection
- ✅ Field validation
- ✅ Detailed error reporting
- ✅ Summary statistics

### Example
```bash
node addQuestionFromJSON.js ./questions.json

🔗 Connecting to MongoDB...
✅ Connected

✅ Added: Q001 (Google - SDE 1)
✅ Added: Q002 (Amazon - SDE 1)
⚠️  Duplicate: Q003 already exists
❌ Error adding Q004: Invalid difficulty

📊 Results: ✅ 2 added, ❌ 2 failed
```

## Method 3: Quick Menu (Easy Access)

### Command
```bash
chmod +x quick-add-question.sh
./quick-add-question.sh
```

### Menu Options
```
1. Add question interactively (CLI)
2. Import questions from JSON file
3. View question template
4. Exit
```

## Question Schema

### Required Fields
- `questionid` (string) - Unique identifier (e.g., "Q001")
- `questiontxt` (string) - Full question description
- `difficulty` (string) - One of: easy, medium, hard, expert
- `role` (string) - One of: SDE 1, SDE 2, SDE 3
- `company` (string) - Company name
- `estimated_time` (number) - Time in minutes

### Optional Fields
- `constraints` (array) - Problem constraints
- `howtoapproach` (string) - Solution approach
- `optimal_solution` (string) - Best/optimal solution code
- `visible_testcases` (object) - Test cases shown to user
- `hidden_testcases` (object) - Hidden test cases for validation
- `edge_testcases` (object) - Edge case test cases

### Test Case Format

Each test case is a key-value pair:

```javascript
{
  "case_1": {
    "input": "5",           // Single or multi-line string
    "output": "120"         // Expected output
  }
}
```

#### Multi-line Input Example
```json
{
  "case_1": {
    "input": "5\n[1,2,3,4,5]\n9",
    "output": "[4,5]"
  }
}
```

## Best Practices

### 1. Naming Convention
- Question IDs: `Q001`, `Q002`, etc.
- Case keys: `case_1`, `case_2`, etc.
- Keep IDs short and memorable

### 2. Test Cases
- Minimum 2 visible test cases
- Include at least 1 hidden test case
- Include edge cases (empty input, boundaries, etc.)
- Ensure outputs match expected format exactly

### 3. Code Quality
- Provide working solutions
- Optimal solution should be clearly better (time/space)
- Test solutions locally before adding
- Use clear variable names and comments

### 4. Difficulty Levels
- **easy**: Basic problems, 15-20 min, simple algorithms
- **medium**: Moderate difficulty, 30-45 min, intermediate concepts
- **hard**: Complex problems, 60-90 min, advanced algorithms
- **expert**: Very hard, 90+ min, specialized knowledge

## Template Files

- `question-template.json` - Example JSON format with 2 complete questions
- `quick-add-question.sh` - Quick access menu

## Troubleshooting

### "MongoDB connection refused"
```bash
# Make sure MongoDB is running
# Linux/Mac: brew services start mongodb-community
# Or check MONGODB_URI in .env
```

### "Invalid difficulty level"
Accepted values: `easy`, `medium`, `hard`, `expert` (case-insensitive)

### "Duplicate question ID"
Question with that ID already exists. Use a unique ID.

### "Missing required fields"
Check JSON structure matches schema. Run with existing template.

## Examples

See `question-template.json` for complete examples with:
- Factorial problem (easy)
- Two Sum problem (easy)

## Tips & Tricks

### Quick JSON Creation
1. Copy `question-template.json`
2. Modify for your questions
3. Run: `node addQuestionFromJSON.js your-questions.json`

### Testing Locally First
Before running test cases on Judge0:
1. Run your code locally
2. Verify all test cases pass
3. Then add to database

### Batch Operations
To add 10+ questions at once:
1. Create JSON file with all questions
2. Run JSON import once
3. Get summary report

## Support

For issues or questions:
1. Check the schema in `models/oaquestions.js`
2. Review example in `question-template.json`
3. Run with `--verbose` flag if available
