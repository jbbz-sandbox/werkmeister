# Security Audit Report

**Date:** 2026-07-25
**Scope:** sandbox codebase with focus on claudeck application

## Critical Findings (Immediate Action Required)

### 1. **CRITICAL: Vulnerable Claude Code Dependency**
**Severity:** HIGH
**Location:** `apps/claudeck/package.json:56`
**Issue:** @anthropic-ai/claude-code@1.0.128 has 12 known high-severity vulnerabilities including:
- Command injection bypasses
- Arbitrary file write vulnerabilities
- Sandbox escapes
- Path restriction bypasses
- Local privilege escalation on Windows

**Fix:**
```bash
cd apps/claudeck
npm audit fix --force
# Updates to @anthropic-ai/claude-code@2.1.220
```

### 2. **CRITICAL: SQL Injection Risk**
**Severity:** HIGH
**Location:** `apps/claudeck/db/sqlite.js`
**Issue:** Multiple `try/catch` blocks silently ignoring errors in database migrations could hide SQL injection or corruption issues.

**Fix:**
```javascript
// Replace silent catches with proper logging
try {
  db.exec(`ALTER TABLE messages ADD COLUMN chat_id TEXT DEFAULT NULL`);
} catch (error) {
  if (!error.message.includes('duplicate column')) {
    console.error('Migration failed:', error);
    throw error;
  }
}
```

## High Priority Findings

### 3. **Database Connection Not Properly Closed**
**Severity:** MEDIUM
**Location:** `apps/claudeck/db/sqlite.js:5`
**Issue:** SQLite database connection is never closed, potentially causing resource leaks.

**Fix:**
```javascript
// Add cleanup handler
process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
```

### 4. **VAPID Keys Auto-Generated Without Backup**
**Severity:** MEDIUM
**Location:** `apps/claudeck/server.js:66-71`
**Issue:** VAPID keys are auto-generated and appended to .env file, but no backup mechanism exists. Loss of keys breaks push notifications for all users.

**Fix:**
- Add backup mechanism before generating new keys
- Log warning about backing up keys
- Consider key rotation strategy

### 5. **Token Passed in Query Parameters**
**Severity:** MEDIUM
**Location:** `apps/claudeck/server/auth.js:58-60`
**Issue:** Accepting auth tokens via URL query parameters can leak tokens in server logs, browser history, and referrer headers.

**Fix:**
```javascript
// Remove query parameter support or add warning
if (qToken) {
  console.warn('Security: Token passed in URL query parameter');
  // Consider rejecting this method entirely
}
```

## Medium Priority Findings

### 6. **Missing Rate Limiting**
**Severity:** MEDIUM
**Location:** `apps/claudeck/server.js`
**Issue:** No rate limiting on API endpoints, vulnerable to DoS attacks.

**Fix:** Add express-rate-limit middleware:
```javascript
import rateLimit from 'express-rate-limit';
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api', limiter);
```

### 7. **Insufficient Input Validation**
**Severity:** MEDIUM
**Location:** Multiple routes in `apps/claudeck/server/routes/`
**Issue:** Missing input validation on API endpoints could lead to injection attacks.

**Fix:** Add validation middleware using libraries like joi or express-validator

### 8. **Cookie Security Configuration**
**Severity:** LOW
**Location:** `apps/claudeck/server/auth.js:129-135`
**Issue:** Cookie secure flag only set for HTTPS, but should always be true in production.

**Fix:**
```javascript
secure: process.env.NODE_ENV === 'production' || req.protocol === 'https'
```

## Code Quality Issues

### 9. **Missing TypeScript Type Safety**
**Severity:** LOW
**Issue:** Entire claudeck application uses JavaScript without type checking.

**Fix:** Migrate to TypeScript or add JSDoc type annotations and configure TypeScript checking.

### 10. **No Linting or Code Style Enforcement**
**Severity:** LOW
**Issue:** No ESLint configuration found for claudeck.

**Fix:** Add ESLint configuration and npm scripts:
```json
{
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit"
  }
}
```

### 11. **Hardcoded Port Without Validation**
**Severity:** LOW
**Location:** `apps/claudeck/server.js:220`
**Issue:** PORT environment variable used without validation.

**Fix:**
```javascript
const PORT = parseInt(process.env.PORT) || 9009;
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('Invalid PORT configuration');
}
```

## Anti-Patterns Identified

1. **Silent Error Handling:** Multiple try/catch blocks that silently swallow errors
2. **Global State:** Session IDs stored in global Map without proper encapsulation
3. **Mixed Async Patterns:** Mixing promises and callbacks throughout codebase
4. **No Dependency Injection:** Hard dependencies make testing difficult
5. **Missing Environment Validation:** No validation of required environment variables at startup

## Recommendations (Priority Order)

1. **IMMEDIATE:** Update @anthropic-ai/claude-code to fix security vulnerabilities
2. **HIGH:** Add proper error handling for database operations
3. **HIGH:** Implement rate limiting on all API endpoints
4. **MEDIUM:** Add input validation middleware
5. **MEDIUM:** Improve authentication security (remove query param support)
6. **LOW:** Add TypeScript or comprehensive JSDoc types
7. **LOW:** Configure ESLint and add pre-commit hooks
8. **LOW:** Add comprehensive test coverage (currently minimal)

## Summary

The codebase has **2 critical security vulnerabilities** that need immediate attention, primarily the vulnerable npm dependency with known exploits. The authentication implementation is reasonably secure with timing-safe comparison, but has some areas for improvement. Database operations need better error handling and resource management.

Total findings:
- Critical: 2
- High: 0
- Medium: 6
- Low: 3
- Code Quality: 5 anti-patterns

**Recommended action:** Fix critical issues immediately, then address medium priority items within the next sprint.