# Privacy Policy Update - Team Discussion

**Date:** December 8, 2025  
**PR:** https://github.com/wonderwhy-er/DesktopCommanderMCP/pull/287  
**Duration:** 15-20 minutes

---

## Context: Why This Update?

1. **Code audit revealed inconsistencies** between what the privacy policy said and what the code actually does
2. **Australian Privacy Act complaint** highlighted specific issues (APP 1, 2, 3, 5)
3. **No changes to actual data collection** — this is about making the policy accurate, not changing behavior

---

## Summary of Changes

### 1. "Anonymous" → "Pseudonymous" 

**Before:** "Anonymous client ID... is not connected to any other telemetry event data"

**After:** "Pseudonymous client ID... is included with telemetry events"

**Why:** The UUID is sent with every event (we need this for retention metrics). Calling it "anonymous" and "isolated" was factually incorrect. Under GDPR, pseudonymous data is still personal data.

---

### 2. Removed "No PII" Claim

**Before:** "avoiding any personally identifiable information (PII)"

**After:** Lists specifically what we don't collect (names, emails, usernames, file paths)

**Why:** 
- Under US law: UUID might not be PII
- Under GDPR: UUID IS personal data
- Safer to be specific about what we don't collect rather than make broad claims

---

### 3. Added Missing Data Fields

**Added disclosures for:**
- Client info (Claude Desktop, VS Code version)
- Container/Docker metadata
- File sizes
- Runtime source

**Why:** These were being collected but not documented. Full transparency.

---

### 4. Named Google Analytics Explicitly

**Before:** "sent securely via HTTPS to Google Analytics" (buried in text)

**After:** Dedicated "Analytics Provider" section naming GA4

**Why:** Industry standard for developer tools. Users expect to know who processes their data.

---

### 5. IP Address Clarification

**Added:** "We do not store IP addresses. However, Google Analytics receives them via HTTPS and auto-anonymizes them."

**Why:** We can't claim "we don't collect IPs" when our analytics provider sees them. This is honest about the technical reality.

---

### 6. Added "Your Rights" Section

**New section includes:**
- List of GDPR rights (access, deletion, objection, withdraw consent)
- How to find your UUID (ask AI or check config file)
- Explanation that we can only process requests with UUID
- 30-day response commitment

**Why:** 
- GDPR/Australian Privacy Act require this
- Explains the privacy paradox: we're SO private we can't identify users
- This is actually a strength, not a weakness

---

### 7. Added Legal Contact Email

**Added:** legal@desktopcommander.app for privacy/legal matters

**Why:** 
- GitHub issues are public — not appropriate for legal matters
- Required for compliance
- We already have this email, just wasn't in the policy

---

### 8. Simplified README Section

**Before:** ~25 lines of privacy details in README

**After:** 5 lines + link to PRIVACY.md

**Why:** Single source of truth, easier maintenance, README was already 960+ lines

---

## Discussion Points

### A. Are we comfortable with "pseudonymous" language?
- Legally accurate
- Might sound scarier than "anonymous" to some users
- But: honesty > marketing

### B. The Australian complaint
- Changes address APP 1 (clear policy), APP 5 (proper notice)
- APP 2 (anonymity option) — we can argue UUID-based system IS effectively anonymous since we can't re-identify
- APP 3 (necessity) — retention metrics are legitimate business need

### C. Should we add anything else?
- Children's data statement? ("Not directed at under-18s")
- Cross-border transfer note? (Data processed in US)
- More detailed retention explanation?

---

## Decisions Needed

1. ✅ / ❌ Approve PR as-is?
2. ✅ / ❌ Add children's data statement?
3. ✅ / ❌ Add cross-border transfer note?
4. ✅ / ❌ Update website privacy policy to match?

---

## Files Changed

| File | Changes |
|------|---------|
| `PRIVACY.md` | Major rewrite — all changes above |
| `README.md` | Simplified privacy section, links to PRIVACY.md |

---

## Post-Meeting Actions

- [ ] Merge PR
- [ ] Update https://legal.desktopcommander.app/privacy_desktop_commander_mcp
- [ ] Mention in next release notes
- [ ] Respond to Discord complaint with link to updated policy
