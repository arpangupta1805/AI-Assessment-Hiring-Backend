#!/bin/bash
# =============================================================================
# Backend API Test Script
# Tests all major endpoints for the AI Hiring Platform
# =============================================================================

BASE_URL="http://localhost:5002"
PASSED=0
FAILED=0
TOTAL=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test function
test_endpoint() {
    local method=$1
    local endpoint=$2
    local expected_status=$3
    local description=$4
    local data=$5
    
    TOTAL=$((TOTAL + 1))
    
    if [ "$method" == "GET" ]; then
        response=$(curl -s -w "\n%{http_code}" "$BASE_URL$endpoint")
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" -H "Content-Type: application/json" -d "$data" "$BASE_URL$endpoint")
    fi
    
    status_code=$(echo "$response" | tail -n 1)
    body=$(echo "$response" | sed '$d')
    
    if [ "$status_code" == "$expected_status" ]; then
        echo -e "${GREEN}✓${NC} [$method] $endpoint - $description (${status_code})"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}✗${NC} [$method] $endpoint - $description"
        echo -e "  Expected: $expected_status, Got: $status_code"
        echo -e "  Response: $(echo $body | head -c 200)"
        FAILED=$((FAILED + 1))
    fi
}

echo "=================================================="
echo "   AI Hiring Platform - Backend API Tests"
echo "=================================================="
echo ""

# =============================================================================
# HEALTH & ROOT
# =============================================================================
echo -e "${YELLOW}📌 Basic Endpoints${NC}"
test_endpoint "GET" "/" "200" "Root endpoint"
test_endpoint "GET" "/health" "200" "Health check"
test_endpoint "GET" "/nonexistent" "404" "404 handler"

echo ""

# =============================================================================
# AUTH ENDPOINTS
# =============================================================================
echo -e "${YELLOW}🔐 Auth Endpoints${NC}"

# Test OTP sending (will fail without valid email config, but endpoint should respond)
test_endpoint "POST" "/api/auth/send-otp" "400" "Send OTP (missing email)" '{}'
test_endpoint "POST" "/api/auth/send-otp" "200" "Send OTP" '{"email":"test@example.com"}'

# Test signup validation
test_endpoint "POST" "/api/auth/signup" "400" "Signup (missing fields)" '{}'
test_endpoint "POST" "/api/auth/signup/recruiter" "400" "Recruiter signup (missing fields)" '{}'

# Test login validation
test_endpoint "POST" "/api/auth/login" "400" "Login (missing fields)" '{}'
test_endpoint "POST" "/api/auth/login" "401" "Login (invalid credentials)" '{"email":"nonexistent@test.com","password":"wrongpass"}'

# Test verify without token
test_endpoint "POST" "/api/auth/verify" "401" "Verify (no token)" '{}'

echo ""

# =============================================================================
# JD ENDPOINTS (Protected)
# =============================================================================
echo -e "${YELLOW}📋 JD Endpoints${NC}"
test_endpoint "GET" "/api/jd" "401" "List JDs (no auth)"
test_endpoint "POST" "/api/jd/upload" "401" "Upload JD (no auth)" '{}'

echo ""

# =============================================================================
# CANDIDATE ENDPOINTS (Public assessment info)
# =============================================================================
echo -e "${YELLOW}👤 Candidate Endpoints${NC}"
test_endpoint "GET" "/api/candidate/assessment/invalid-link" "404" "Get assessment (invalid link)"
test_endpoint "POST" "/api/candidate/register/invalid-link" "400" "Register (missing fields)" '{}'
test_endpoint "POST" "/api/candidate/register/invalid-link" "404" "Register (invalid link)" '{"email":"test@example.com","name":"Test User"}'

echo ""

# =============================================================================
# ASSESSMENT ENDPOINTS (Protected)
# =============================================================================
echo -e "${YELLOW}📝 Assessment Endpoints${NC}"
test_endpoint "GET" "/api/assessment/session" "401" "Get session (no auth)"
test_endpoint "GET" "/api/assessment/questions/objective" "401" "Get questions (no auth)"

echo ""

# =============================================================================
# CODE ENDPOINTS (Protected)
# =============================================================================
echo -e "${YELLOW}💻 Code Endpoints${NC}"
test_endpoint "GET" "/api/code/languages" "401" "Get languages (no auth)"
test_endpoint "POST" "/api/code/run" "401" "Run code (no auth)" '{}'

echo ""

# =============================================================================
# EVALUATION ENDPOINTS (Protected)
# =============================================================================
echo -e "${YELLOW}✅ Evaluation Endpoints${NC}"
test_endpoint "GET" "/api/eval/result/invalidid" "401" "Get result (no auth)"
test_endpoint "POST" "/api/eval/trigger/invalidid" "401" "Trigger eval (no auth)" '{}'

echo ""

# =============================================================================
# ADMIN ENDPOINTS (Protected)
# =============================================================================
echo -e "${YELLOW}⚙️  Admin Endpoints${NC}"
test_endpoint "GET" "/api/admin/jds" "401" "List JDs (no auth)"
test_endpoint "GET" "/api/admin/analytics/invalidid" "401" "Get analytics (no auth)"

echo ""

# =============================================================================
# EMAIL ENDPOINTS (Protected)
# =============================================================================
echo -e "${YELLOW}📧 Email Endpoints${NC}"
test_endpoint "GET" "/api/email/templates" "401" "Get templates (no auth)"
test_endpoint "POST" "/api/email/send-bulk" "401" "Send bulk email (no auth)" '{}'

echo ""

# =============================================================================
# SUMMARY
# =============================================================================
echo "=================================================="
echo -e "   ${YELLOW}Test Results${NC}"
echo "=================================================="
echo -e "   Total:  $TOTAL"
echo -e "   ${GREEN}Passed: $PASSED${NC}"
echo -e "   ${RED}Failed: $FAILED${NC}"
echo "=================================================="

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed.${NC}"
    exit 1
fi
