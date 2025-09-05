# Onboarding System Testing Guide

## **🧪 New Implementation Summary**

### **Key Changes Made:**

1. **Show on first call** instead of 3-10 calls
2. **Minute-based backoff** for testing (2min → 5min → 10min)
3. **Progressive retry system** with max 3 attempts
4. **Enhanced debug logging** for testing
5. **Show count tracking** with attempt counter in message
6. **Auto-dismiss** after 3 failed attempts

### **New OnboardingState Structure:**
```typescript
{
  onboardingShown: boolean;        // Has been shown at least once?
  onboardingAccepted: boolean;     // Did user call get_prompts?
  onboardingDismissed: boolean;    // Permanently dismissed?
  onboardingShownAt: number;       // First time shown (analytics)
  showCount: number;               // How many times shown (NEW)
  lastShownAt: number;             // Last time shown (NEW)
}
```

### **Testing Timeline:**

| Attempt | Trigger | Delay | Message Content |
|---------|---------|-------|-----------------|
| 1 | First successful call | Immediate | "Using Desktop Commander for the first time?" |
| 2 | 2+ calls + 2min delay | 2 minutes | "Still exploring...? (Attempt 2/3)" |  
| 3 | 4+ calls + 5min delay | 5 minutes | "Still exploring...? (Attempt 3/3)" |
| 4+ | 6+ calls + 10min delay | Auto-dismiss | No more attempts |

### **Debug Output to Watch:**
```
[ONBOARDING DEBUG] Should show onboarding: true
[ONBOARDING DEBUG] First time showing onboarding message
[ONBOARDING DEBUG] Marked onboarding shown (attempt 1/3)
[ONBOARDING DEBUG] Retry check - showCount: 1, timeSince: 45s
[ONBOARDING DEBUG] Required delay: 120s, actual: 45s
[ONBOARDING DEBUG] Not enough time passed for retry attempt 2
```

### **Testing Checklist:**

- [ ] First call triggers onboarding immediately
- [ ] Message shows attempt counter (1/3, 2/3, 3/3)
- [ ] 2-minute delay works for retry #2
- [ ] 5-minute delay works for retry #3  
- [ ] Auto-dismiss after 3 attempts
- [ ] Acceptance works when user calls `get_prompts`
- [ ] Debug logs help track behavior

### **Easy Reset for Testing:**
Add to server.ts if needed:
```typescript
case "reset_onboarding_test":
  await usageTracker.resetOnboardingState();
  result = { content: [{ type: "text", text: "Onboarding state reset for testing" }] };
  break;
```

### **Ready for Production:**
Change delays in `shouldShowOnboarding()` from:
```typescript
const delays = [
  2 * 60 * 1000,    // 2 minutes (testing)
  5 * 60 * 1000,    // 5 minutes (testing)  
  10 * 60 * 1000    // 10 minutes (testing)
];
```

To 10-minute intervals:
```typescript
const delays = [
  10 * 60 * 1000,   // 10 minutes
  10 * 60 * 1000,   // 10 minutes  
  10 * 60 * 1000    // 10 minutes
];
```
