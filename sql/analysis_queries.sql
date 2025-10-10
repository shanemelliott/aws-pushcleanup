-- Sample queries to analyze the cleanup results

-- Get summary statistics
SELECT 
    COUNT(*) as total_records,
    COUNT(CASE WHEN status = 'ENABLED' THEN 1 END) as enabled_count,
    COUNT(CASE WHEN status = 'DISABLED' THEN 1 END) as disabled_count,
    COUNT(CASE WHEN status = 'ERROR' THEN 1 END) as error_count,
    COUNT(CASE WHEN status = 'NOT_FOUND' THEN 1 END) as not_found_count,
    CAST(COUNT(CASE WHEN status = 'DISABLED' THEN 1 END) * 100.0 / COUNT(*) AS DECIMAL(5,2)) as disabled_percentage
FROM CDW_push_arn_cleanup_results;

-- Get disabled ARNs (candidates for cleanup)
SELECT 
    original_id,
    arn,
    status_reason,
    checked_at
FROM CDW_push_arn_cleanup_results 
WHERE status = 'DISABLED'
ORDER BY checked_at DESC;

-- Get error cases that might need manual review
SELECT 
    original_id,
    arn,
    status_reason,
    error_message,
    checked_at
FROM CDW_push_arn_cleanup_results 
WHERE status = 'ERROR'
ORDER BY checked_at DESC;

-- Get not found cases (ARNs that don't exist in SNS)
SELECT 
    original_id,
    arn,
    status_reason,
    checked_at
FROM CDW_push_arn_cleanup_results 
WHERE status = 'NOT_FOUND'
ORDER BY checked_at DESC;

-- Get results by date
SELECT 
    CAST(checked_at AS DATE) as check_date,
    COUNT(*) as total_checked,
    COUNT(CASE WHEN status = 'ENABLED' THEN 1 END) as enabled,
    COUNT(CASE WHEN status = 'DISABLED' THEN 1 END) as disabled,
    COUNT(CASE WHEN status = 'ERROR' THEN 1 END) as errors,
    COUNT(CASE WHEN status = 'NOT_FOUND' THEN 1 END) as not_found
FROM CDW_push_arn_cleanup_results 
GROUP BY CAST(checked_at AS DATE)
ORDER BY check_date DESC;