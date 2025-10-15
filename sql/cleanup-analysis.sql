-- =====================================================
-- CLEANUP DEPENDENCY ANALYSIS
-- Analysis of 584,882 disabled ARNs and related records
-- =====================================================

-- Step 1: Verify our disabled records count
SELECT 
    'Disabled ARNs from cleanup run' as analysis_type,
    COUNT(*) as total_count,
    MIN(checked_at) as earliest_record,
    MAX(checked_at) as latest_record
FROM CDW_push_arn_cleanup_results 
WHERE run_id = 'run-2025-10-07T18-30-15-u0qn' 
AND status = 'DISABLED';

-- Step 2: Cross-reference with smsMobileClient table
SELECT 
    'smsMobileClient records to be disabled' as analysis_type,
    COUNT(*) as total_records,
    COUNT(CASE WHEN mc.active = 1 THEN 1 END) as currently_active,
    COUNT(CASE WHEN mc.active = 0 THEN 1 END) as already_inactive,
    COUNT(CASE WHEN mc.targetArn IS NULL THEN 1 END) as null_target_arn
FROM CDW_push_arn_cleanup_results cr
INNER JOIN smsMobileClient mc ON mc.id = cr.original_id
WHERE cr.run_id = 'run-2025-10-07T18-30-15-u0qn' 
AND cr.status = 'DISABLED';

-- Step 3: Analyze smsMobileClientPreference dependencies
SELECT 
    'Related smsMobileClientPreference records' as analysis_type,
    COUNT(mcp.id) as total_preference_records,
    COUNT(DISTINCT mcp.clientId) as unique_mobile_clients,
    COUNT(CASE WHEN mcp.active = 1 THEN 1 END) as currently_active_prefs,
    COUNT(CASE WHEN mcp.active = 0 THEN 1 END) as already_inactive_prefs
FROM CDW_push_arn_cleanup_results cr
INNER JOIN smsMobileClient mc ON mc.id = cr.original_id
LEFT JOIN smsMobileClientPreference mcp ON mcp.clientId = mc.id
WHERE cr.run_id = 'run-2025-10-07T18-30-15-u0qn' 
AND cr.status = 'DISABLED';

-- Step 4: Analyze preference types for disabled records
SELECT 
    mp.prefName,
    mp.prefId,
    COUNT(*) as preference_count,
    COUNT(CASE WHEN mcp.active = 1 THEN 1 END) as active_count,
    COUNT(CASE WHEN mcp.active = 0 THEN 1 END) as inactive_count
FROM CDW_push_arn_cleanup_results cr
INNER JOIN smsMobileClient mc ON mc.id = cr.original_id
INNER JOIN smsMobileClientPreference mcp ON mcp.clientId = mc.id
INNER JOIN smsMobilePreference mp ON mp.id = mcp.preferenceId
WHERE cr.run_id = 'run-2025-10-07T18-30-15-u0qn' 
AND cr.status = 'DISABLED'
GROUP BY mp.prefName, mp.prefId
ORDER BY preference_count DESC;

-- Step 5: Check for any notification history dependencies
SELECT 
    'Related notification history records' as analysis_type,
    COUNT(nh.id) as total_notification_records,
    COUNT(DISTINCT nh.mobileClientId) as unique_mobile_clients,
    MIN(nh.sentDate) as earliest_notification,
    MAX(nh.sentDate) as latest_notification
FROM CDW_push_arn_cleanup_results cr
INNER JOIN smsMobileClient mc ON mc.id = cr.original_id
LEFT JOIN notificationHistory nh ON nh.smsMobileClientId = mc.id
WHERE cr.run_id = 'run-2025-10-07T18-30-15-u0qn' 
AND cr.status = 'DISABLED';

-- Step 6: Analyze person relationships (to understand user impact)
SELECT 
    'Person/User impact analysis' as analysis_type,
    COUNT(DISTINCT mc.personId) as unique_persons_affected,
    COUNT(*) as total_mobile_client_records,
    AVG(CAST(devices_per_person as FLOAT)) as avg_devices_per_person
FROM (
    SELECT 
        mc.personId,
        COUNT(*) as devices_per_person
    FROM CDW_push_arn_cleanup_results cr
    INNER JOIN smsMobileClient mc ON mc.id = cr.original_id
    WHERE cr.run_id = 'run-2025-10-07T18-30-15-u0qn' 
    AND cr.status = 'DISABLED'
    AND mc.personId IS NOT NULL
    GROUP BY mc.personId
) person_stats;

-- Step 7: Check for any active devices for the same persons
SELECT 
    'Persons with both active and disabled devices' as analysis_type,
    COUNT(*) as persons_with_mixed_devices
FROM (
    SELECT 
        mc.personId
    FROM CDW_push_arn_cleanup_results cr
    INNER JOIN smsMobileClient mc ON mc.id = cr.original_id
    WHERE cr.run_id = 'run-2025-10-07T18-30-15-u0qn' 
    AND cr.status = 'DISABLED'
    AND mc.personId IS NOT NULL
    
    INTERSECT
    
    SELECT 
        mc2.personId
    FROM smsMobileClient mc2
    WHERE mc2.active = 1 
    AND mc2.targetArn IS NOT NULL
) mixed_persons;

-- Step 8: Sample of records to be cleaned up (for verification)
SELECT TOP 10
    cr.original_id,
    cr.arn,
    mc.personId,
    mc.active as current_active_status,
    mc.createdDate as mobile_client_created,
    COUNT(mcp.id) as preference_count,
    COUNT(nh.id) as notification_history_count
FROM CDW_push_arn_cleanup_results cr
INNER JOIN smsMobileClient mc ON mc.id = cr.original_id
LEFT JOIN smsMobileClientPreference mcp ON mcp.clientId = mc.id
LEFT JOIN notificationHistory nh ON nh.smsMobileClientId = mc.id
WHERE cr.run_id = 'run-2025-10-07T18-30-15-u0qn' 
AND cr.status = 'DISABLED'
GROUP BY cr.original_id, cr.arn, mc.personId, mc.active, mc.createdDate
ORDER BY mc.createdDate DESC;

-- Step 9: Summary for cleanup planning
SELECT 
    'CLEANUP SUMMARY' as analysis_type,
    (SELECT COUNT(*) FROM CDW_push_arn_cleanup_results WHERE run_id = 'run-2025-10-07T18-30-15-u0qn' AND status = 'DISABLED') as total_arns_to_delete,
    (SELECT COUNT(*) FROM CDW_push_arn_cleanup_results cr INNER JOIN smsMobileClient mc ON mc.id = cr.original_id WHERE cr.run_id = 'run-2025-10-07T18-30-15-u0qn' AND cr.status = 'DISABLED' AND mc.active = 1) as mobile_clients_to_disable,
    (SELECT COUNT(*) FROM CDW_push_arn_cleanup_results cr INNER JOIN smsMobileClient mc ON mc.id = cr.original_id INNER JOIN smsMobileClientPreference mcp ON mcp.clientId = mc.id WHERE cr.run_id = 'run-2025-10-07T18-30-15-u0qn' AND cr.status = 'DISABLED' AND mcp.active = 1) as preferences_to_disable,
    (SELECT COUNT(DISTINCT mc.personId) FROM CDW_push_arn_cleanup_results cr INNER JOIN smsMobileClient mc ON mc.id = cr.original_id WHERE cr.run_id = 'run-2025-10-07T18-30-15-u0qn' AND cr.status = 'DISABLED' AND mc.personId IS NOT NULL) as unique_persons_affected;