# AWS SNS Push Notification Cleanup Analysis & Solutions

## Executive Summary

VEText has accumulated **4.2 million push notification endpoints** with **562,912 already identified as disabled**. This document outlines the problem, analysis, and proposed solutions for cleaning up orphaned AWS SNS endpoints to improve system performance and reduce costs.

## Problem Statement

### Initial Issue
- **4.2+ million push notification ARNs** stored in `smsMobileClient` table
- **Orphaned endpoints** from users who uninstalled apps or opted out
- **Performance degradation** when sending push notifications
- **Increased AWS costs** from disabled endpoints

### Root Cause Analysis
The original engineering discussion revealed a concern that deleting on logout might not be the intended action of the user (stop recieving push notifications)

**Current VEText behavior:**
- Users logout ≠ delete push token
- App uninstalls create orphaned endpoints
- No automated cleanup of truly abandoned devices

## Data Analysis

### Current Database State
```sql
SELECT 
  COUNT(*) as total_records,
  COUNT(CASE WHEN active = 1 THEN 1 END) as active_records,
  COUNT(CASE WHEN active = 0 THEN 1 END) as inactive_records
FROM smsMobileClient 
WHERE targetArn IS NOT NULL;
```

**Results:**
- **Total Records**: 4,189,257
- **Active (active=1)**: 3,626,345 (86.6%)
- **Inactive (active=0)**: 562,912 (13.4%)

### VEText Auto-Detection System

**Code Reference:** `MobilePushServiceImpl.java`
```java
private void handlePushNotificationException(MobileClient client, Exception e) {
  if ((e != null) && (e.getMessage() != null) && 
       e.getMessage().contains("Endpoint is disabled")) {
    
    client.setActive(false);  // Automatically marks as disabled
    this.updateMobileClient(client);  
  }
}
```

**Key Finding:** VEText already automatically detects and marks disabled endpoints when push notifications fail with "Endpoint is disabled" errors.

### Database Schema
**Table:** `smsMobileClient` extends `BaseHibernateModel`

**Code Reference:** `BaseHibernateModel.java`
```java
@MappedSuperclass
public abstract class BaseHibernateModel extends ModelObject implements Serializable {
  private boolean active = true;  // The active column we can leverage!
  
  public boolean getActive() {
    return this.active;
  }
  
  public void setActive(boolean active) {
    this.active = active;
  }
}
```

## Current Cleanup Tool Status

### Implementation Progress
- ✅ **AWS SNS ARN validation tool** built with Node.js
- ✅ **Auto-batch processing** for 4M+ records
- ✅ **Resume capability** with run tracking
- ✅ **AWS credential auto-refresh** (fixed token expiration)
- ✅ **Database persistence** with progress tracking
- ✅ **Server deployment ready** with PM2 configuration

### Processing Performance
**Current Production Run Results (run-2025-10-07T18-30-15-u0qn):**
- **Total Processed**: 462,495 records (11.03% of 4.2M total)
- **Enabled ARNs**: 329,181 (71.2%)
- **Disabled ARNs**: 133,302 (28.8%)
- **Errors**: 9 (0.002%)
- **Not Found**: 3 (0.001%)
- **Success Rate**: 99.997%

**Progress Tracking:**
- **Records Processed**: 462,495 / 4,189,257 (11.03% complete)
- **Estimated Time Remaining**: ~80-90% of total processing time
- **Cleanup Candidates Found**: 133,302 disabled endpoints ready for removal

**Important Context**: These results represent the **oldest records** in the database (processing chronologically), which explains the sustained high disabled rate of 28.8% vs. VEText's overall 13.4%. The rate has remained consistent as expected for legacy endpoints with higher abandonment due to:
- App uninstalls over time
- Device replacements  
- User churn from legacy registrations

**Performance Metrics:**
- **Batch Size**: 50 ARNs per batch
- **Processing Time**: ~800ms per batch
- **Validation Accuracy**: High precision endpoint status detection
- **Expected Trend**: Disabled rate should decrease as processing reaches newer records

## Proposed Solutions

### 1. **Immediate Efficiency Gain: Leverage Active Column**

**Strategy:** Use VEText's existing disabled endpoint detection instead of re-checking via AWS API.

#### Phase 1: Process Pre-Identified Disabled Endpoints
```bash
# Process 562,912 records already marked as disabled by VEText
npx cross-env NODE_ENV=production node src/cleanup.js --where-clause "active = 0"
```

**Benefits:**
- **562K fewer AWS API calls**
- **Instant cleanup candidates**
- **Hours vs. days processing time**

#### Phase 2: Verify Remaining Active Endpoints (Optional)
```bash
# Verify 3.6M records VEText thinks are still active
npx cross-env NODE_ENV=production node src/cleanup.js --where-clause "active = 1"
```

### 2. **Long-term Prevention Strategies**

#### Token Health Monitoring
```javascript
const validatePushTokens = async () => {
  const tokens = await getActiveTokens();
  for (const token of tokens) {
    // Test with silent push, mark failed tokens for cleanup
    const result = await sns.publish({
      TargetArn: token.arn,
      Message: JSON.stringify({
        aps: { 'content-available': 1 }, // Silent push
        data: { type: 'health_check' }
      })
    });
  }
};
```

#### App State-Based Cleanup
```javascript
const cleanupInactiveTokens = async () => {
  const inactiveTokens = await db.query(`
    SELECT * FROM smsMobileClient 
    WHERE last_seen < DATEADD(day, -90, GETDATE())
  `);
  // Validate and cleanup old tokens
};
```

#### User Preference Management
- Let users control push notification lifecycle
- Distinguish between temporary logout vs. permanent device abandonment
- Smart logout detection (temporary, permanent, security)

### 3. **Alternative Logout Handling**

Instead of deleting tokens on logout, implement:

```javascript
const logoutTypes = {
  TEMPORARY: 'temporary',    // Keep push active
  PERMANENT: 'permanent',    // Schedule cleanup (7 days)
  SECURITY: 'security'       // Immediate cleanup
};
```

## Implementation Recommendations

### Immediate Actions (Week 1)
1. **Add `--where-clause` parameter** to existing cleanup tool
2. **Process 562K disabled endpoints** using `active = 0` filter
3. **Measure cleanup impact** on system performance

### Short-term (Month 1)
1. **Implement token health monitoring** (weekly validation)
2. **Add user preference controls** for push lifecycle
3. **Deploy server-based auto-processing**

### Long-term (Quarter 1)
1. **Smart device management** based on app usage patterns
2. **Automated cleanup policies** for abandoned devices
3. **Enhanced logout type detection**

## Code References

### Key Files Analyzed
- `MobilePushServiceImpl.java` - Push notification handling and auto-disable logic
- `BaseHibernateModel.java` - Active column definition
- `MobileClient.java` - Entity model for `smsMobileClient` table
- `PushNotificationsResource.java` - Endpoint activation/deactivation APIs

### VEText Auto-Disable Workflow
1. **Send Push Notification** → AWS SNS API
2. **Receive "Endpoint Disabled"** → Exception handling
3. **Mark as Inactive** → `client.setActive(false)`
4. **Update Database** → `active = 0` in `smsMobileClient`

## Expected Outcomes

### Immediate Benefits
- **13.4% reduction** in push notification overhead (562K disabled endpoints)
- **Faster processing** for remaining active endpoints
- **Reduced AWS costs** from eliminating disabled endpoint calls

### Long-term Benefits
- **Proactive endpoint health management**
- **User-controlled push notification preferences**
- **Automated cleanup preventing future accumulation**
- **Improved system performance** and reliability

## Technical Implementation

The current cleanup tool is production-ready with:
- **Auto-batching capability** for processing millions of records
- **Resume functionality** for interrupted runs
- **AWS credential auto-refresh** for long-running processes
- **Comprehensive logging** and progress tracking
- **Server deployment configuration** with PM2 process management

**Next Step:** Implement `--where-clause` parameter to leverage the existing `active = 0` data for immediate efficiency gains.

---

*Analysis based on VEText codebase review and production database analysis conducted October 2025*