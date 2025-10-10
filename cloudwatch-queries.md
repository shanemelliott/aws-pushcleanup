# CloudWatch Insights Queries for AWS Pinpoint Endpoint Monitoring

## 1. Endpoint Disabled Events Frequency

### Query: Count of endpoint disabled events over time
```
fields @timestamp, @message
| filter @message like /disabled|opted.out|uninstall|inactive/
| stats count() by bin(5m)
| sort @timestamp desc
```

### Query: Hourly endpoint disabled events
```
fields @timestamp, @message
| filter @message like /endpoint.*disabled|EndpointStatus.*INACTIVE/
| stats count() as DisabledCount by bin(1h)
| sort @timestamp desc
```

## 2. Pinpoint Application Events

### Query: All Pinpoint endpoint status changes
```
fields @timestamp, @message, @requestId
| filter @message like /Pinpoint/ or @logStream like /pinpoint/
| filter @message like /endpoint|EndpointStatus|OptOut/
| sort @timestamp desc
| limit 100
```

### Query: Endpoint registration vs deactivation
```
fields @timestamp, @message
| filter @message like /endpoint/
| stats 
    count(@message[*EndpointStatus*="ACTIVE"]) as ActiveEndpoints,
    count(@message[*EndpointStatus*="INACTIVE"]) as InactiveEndpoints,
    count(@message[*OptOut*="ALL"]) as OptedOutEndpoints
by bin(1h)
| sort @timestamp desc
```

## 3. Application-Specific Monitoring

### Query: Mobile app uninstall patterns
```
fields @timestamp, @message
| filter @message like /uninstall|removed|deleted|disabled/
| filter @message like /mobile|app|device/
| stats count() as UninstallEvents by bin(30m)
| sort @timestamp desc
```

### Query: Push notification delivery failures
```
fields @timestamp, @message, @logStream
| filter @message like /delivery.*fail|notification.*fail|endpoint.*invalid/
| filter @logStream like /pinpoint/ or @message like /Pinpoint/
| stats count() as FailedDeliveries by bin(15m)
| sort @timestamp desc
```

## 4. Endpoint Lifecycle Monitoring

### Query: New vs Disabled endpoints ratio
```
fields @timestamp, @message
| filter @message like /endpoint/
| stats 
    count(@message[*created*] or @message[*registered*]) as NewEndpoints,
    count(@message[*disabled*] or @message[*inactive*]) as DisabledEndpoints
by bin(1h)
| eval DisableRate = DisabledEndpoints / (NewEndpoints + DisabledEndpoints) * 100
| sort @timestamp desc
```

### Query: Endpoint status distribution
```
fields @timestamp, @message
| filter @message like /EndpointStatus/ or @message like /endpoint.*status/
| parse @message /EndpointStatus[:\s]*(?<status>\w+)/
| stats count() by status, bin(1h)
| sort @timestamp desc
```

## 5. Error and Exception Monitoring

### Query: Pinpoint API errors related to endpoints
```
fields @timestamp, @message, @type
| filter @type = "ERROR" or @message like /error|exception|fail/
| filter @message like /pinpoint|endpoint|arn:aws:mobiletargeting/
| stats count() as ErrorCount by bin(30m)
| sort @timestamp desc
```

### Query: Specific endpoint not found errors
```
fields @timestamp, @message, @requestId
| filter @message like /NotFoundException|endpoint.*not.*found|invalid.*endpoint/
| stats count() as NotFoundErrors by bin(1h)
| sort @timestamp desc
```

## 6. Your Cleanup Application Monitoring

### Query: Monitor your cleanup application logs
```
fields @timestamp, @message
| filter @logGroup like /aws-pinpoint-cleanup/ or @message like /ARN.*check|endpoint.*check/
| filter @message like /DISABLED|NOT_FOUND|status/
| stats 
    count(@message[*DISABLED*]) as DisabledCount,
    count(@message[*NOT_FOUND*]) as NotFoundCount,
    count(@message[*ERROR*]) as ErrorCount
by bin(1h)
| sort @timestamp desc
```

### Query: Cleanup application performance metrics
```
fields @timestamp, @message, @duration
| filter @message like /cleanup.*process|batch.*process|ARN.*check/
| stats 
    avg(@duration) as AvgDuration,
    max(@duration) as MaxDuration,
    count() as ProcessedBatches
by bin(30m)
| sort @timestamp desc
```

## 7. Alerting Queries

### Query: High disabled endpoint rate (for alerting)
```
fields @timestamp, @message
| filter @message like /disabled|inactive|opted.*out/
| stats count() as DisabledCount by bin(5m)
| sort @timestamp desc
| limit 1
```

### Query: Unusual endpoint activity spikes
```
fields @timestamp, @message
| filter @message like /endpoint/
| stats count() as EndpointActivity by bin(15m)
| sort @timestamp desc
| limit 12
```

## 8. Custom Metrics for Dashboard

### Query: Daily endpoint health summary
```
fields @timestamp, @message
| filter @message like /endpoint.*status|EndpointStatus|OptOut/
| stats 
    count(@message[*ACTIVE*]) as Active,
    count(@message[*INACTIVE*]) as Inactive,
    count(@message[*OptOut*]) as OptedOut,
    count() as Total
by bin(1d)
| eval HealthPercentage = (Active / Total) * 100
| sort @timestamp desc
```

## Usage Instructions:

1. **Access CloudWatch Insights**: Go to AWS Console → CloudWatch → Insights
2. **Select Log Groups**: Choose your Pinpoint application log groups
3. **Time Range**: Set appropriate time range (last 24 hours, 7 days, etc.)
4. **Run Queries**: Copy and paste the queries above
5. **Create Dashboards**: Save useful queries to CloudWatch dashboards
6. **Set Alerts**: Use the alerting queries to create CloudWatch alarms

## Log Groups to Monitor:

- `/aws/pinpoint/your-app-id` - Pinpoint application logs
- `/aws/lambda/your-function-name` - If using Lambda for push handling
- Your custom application logs (if deployed to AWS)
- API Gateway logs (if using API Gateway)

## Recommended Alerts:

1. **High Disable Rate**: Alert when disabled endpoints > X per hour
2. **Error Spike**: Alert when endpoint errors > Y per 15 minutes  
3. **Not Found Rate**: Alert when NotFound errors > Z per hour