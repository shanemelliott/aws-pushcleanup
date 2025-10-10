# CloudWatch Insights Queries for Amazon SNS Push Notifications

## Based on your log format - SNS APNS/FCM endpoint monitoring

## 1. Endpoint Disabled/Unregistered Events

### Query: Count of unregistered endpoints over time
```
fields @timestamp, delivery.providerResponse, delivery.destination, status
| filter status = "FAILURE" 
| filter delivery.providerResponse like /Unregistered|InvalidRegistration|NotRegistered/
| stats count() as UnregisteredCount by bin(5m)
| sort @timestamp desc
```

### Query: Hourly failure analysis by reason
```
fields @timestamp, delivery.providerResponse, delivery.statusCode, status
| filter status = "FAILURE"
| parse delivery.providerResponse /\"reason\":\"(?<failureReason>[^\"]+)\"/
| stats count() as FailureCount by failureReason, bin(1h)
| sort @timestamp desc
```

## 2. Specific Endpoint Status Monitoring

### Query: APNS Unregistered devices (410 status code)
```
fields @timestamp, delivery.destination, delivery.providerResponse, delivery.statusCode
| filter delivery.statusCode = 410
| filter delivery.providerResponse like /Unregistered/
| stats count() as UnregisteredDevices by bin(15m)
| sort @timestamp desc
```

### Query: All APNS vs FCM failures
```
fields @timestamp, delivery.destination, delivery.providerResponse, status
| filter status = "FAILURE"
| parse delivery.destination /endpoint\/(?<platform>\w+)\//
| stats count() as FailureCount by platform, bin(1h)
| sort @timestamp desc
```

## 3. Token and Endpoint Analysis

### Query: Failed deliveries by endpoint ARN
```
fields @timestamp, delivery.destination, delivery.providerResponse, delivery.statusCode
| filter status = "FAILURE"
| stats count() as FailureCount by delivery.destination
| sort FailureCount desc
| limit 50
```

### Query: Device tokens causing failures
```
fields @timestamp, delivery.token, delivery.providerResponse, delivery.statusCode
| filter status = "FAILURE"
| filter delivery.providerResponse like /Unregistered|InvalidRegistration/
| stats count() as FailureCount by delivery.token
| sort FailureCount desc
| limit 20
```

## 4. Performance and Delivery Metrics

### Query: Delivery success vs failure rates
```
fields @timestamp, status, delivery.dwellTimeMs
| stats 
    count(status = "SUCCESS") as SuccessCount,
    count(status = "FAILURE") as FailureCount,
    avg(delivery.dwellTimeMs) as AvgDwellTime
by bin(30m)
| eval SuccessRate = (SuccessCount / (SuccessCount + FailureCount)) * 100
| sort @timestamp desc
```

### Query: High dwell time analysis
```
fields @timestamp, delivery.dwellTimeMs, delivery.destination, status
| filter delivery.dwellTimeMs > 1000
| stats 
    avg(delivery.dwellTimeMs) as AvgDwellTime,
    max(delivery.dwellTimeMs) as MaxDwellTime,
    count() as SlowDeliveries
by bin(1h)
| sort @timestamp desc
```

## 5. Error Code Analysis

### Query: All HTTP status codes breakdown
```
fields @timestamp, delivery.statusCode, delivery.providerResponse, status
| filter status = "FAILURE"
| stats count() as ErrorCount by delivery.statusCode, bin(1h)
| sort @timestamp desc
```

### Query: Critical error codes (400s and 500s)
```
fields @timestamp, delivery.statusCode, delivery.providerResponse, delivery.destination
| filter delivery.statusCode >= 400
| parse delivery.providerResponse /\"reason\":\"(?<reason>[^\"]+)\"/
| stats count() as ErrorCount by delivery.statusCode, reason, bin(30m)
| sort @timestamp desc
```

## 6. Platform-Specific Queries

### Query: APNS specific errors
```
fields @timestamp, delivery.destination, delivery.providerResponse, delivery.statusCode
| filter delivery.destination like /APNS/
| filter status = "FAILURE"
| parse delivery.providerResponse /\"reason\":\"(?<apnsReason>[^\"]+)\"/
| stats count() by apnsReason, bin(1h)
| sort @timestamp desc
```

### Query: FCM specific errors
```
fields @timestamp, delivery.destination, delivery.providerResponse, delivery.statusCode
| filter delivery.destination like /GCM|FCM/
| filter status = "FAILURE"
| parse delivery.providerResponse /\"reason\":\"(?<fcmReason>[^\"]+)\"/
| stats count() by fcmReason, bin(1h)
| sort @timestamp desc
```

## 7. Cleanup Application Monitoring

### Query: Endpoints that need cleanup (Unregistered)
```
fields @timestamp, delivery.destination, delivery.token, delivery.providerResponse
| filter status = "FAILURE"
| filter delivery.providerResponse like /Unregistered|InvalidRegistration|NotRegistered/
| stats latest(@timestamp) as LastFailure by delivery.destination, delivery.token
| sort LastFailure desc
```

### Query: Daily cleanup candidates
```
fields @timestamp, delivery.destination, delivery.providerResponse
| filter status = "FAILURE"
| filter delivery.providerResponse like /Unregistered/
| stats count() as UnregisteredCount by bin(1d), delivery.destination
| sort @timestamp desc
```

## 8. Alerting Queries

### Query: High unregistered rate (for alerts)
```
fields @timestamp, status, delivery.providerResponse
| filter status = "FAILURE"
| filter delivery.providerResponse like /Unregistered/
| stats count() as UnregisteredCount by bin(5m)
| sort @timestamp desc
| limit 1
```

### Query: Sudden spike in failures
```
fields @timestamp, status
| filter status = "FAILURE"
| stats count() as FailureCount by bin(15m)
| sort @timestamp desc
| limit 8
```

## Usage Instructions:

1. **Log Group**: Look for log groups like:
   - `/aws/sns/us-gov-west-1/171875617347/DirectPublishToPhoneNumber/Failure`
   - `/aws/sns/platform-application/your-app-name`
   - Custom log groups for your SNS platform applications

2. **Time Range**: Set appropriate range (last 24 hours recommended)

3. **Key Metrics to Monitor**:
   - **Status Code 410**: Unregistered devices (app uninstalled)
   - **"Unregistered" reason**: Primary cleanup candidates
   - **High failure rates**: Potential issues with certificates/configuration

## Recommended Alerts:

1. **Unregistered Spike**: > 50 unregistered endpoints per 15 minutes
2. **High Failure Rate**: Failure rate > 20% for 30 minutes  
3. **Certificate Issues**: Status codes 403/401 indicating cert problems
4. **Platform Issues**: Sudden increase in 500-level errors

## Common APNS Error Reasons:
- **"Unregistered"**: App deleted/token invalid (410)
- **"BadDeviceToken"**: Invalid token format (400)
- **"DeviceTokenNotForTopic"**: Wrong certificate (400)
- **"TopicDisallowed"**: Certificate/topic mismatch (400)