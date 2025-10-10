-- Create the results table for storing ARN status check results
-- This table will store the results of checking each push notification ARN

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='CDW_push_arn_cleanup_results' AND xtype='U')
BEGIN
    CREATE TABLE CDW_push_arn_cleanup_results (
        id BIGINT IDENTITY(1,1) PRIMARY KEY,
        original_id BIGINT NOT NULL,  -- Reference to the original record ID
        arn NVARCHAR(500) NOT NULL,   -- The ARN that was checked
        status NVARCHAR(50) NOT NULL, -- ENABLED, DISABLED, ERROR, NOT_FOUND
        status_reason NVARCHAR(200),  -- Detailed reason for the status
        error_message NVARCHAR(MAX),  -- Error details if status is ERROR
        metadata NVARCHAR(MAX),       -- JSON metadata about the check
        checked_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(), -- When the check was performed
        
        -- Indexes for better query performance
        INDEX IX_CDW_push_arn_cleanup_results_arn (arn),
        INDEX IX_CDW_push_arn_cleanup_results_status (status),
        INDEX IX_CDW_push_arn_cleanup_results_checked_at (checked_at),
        INDEX IX_CDW_push_arn_cleanup_results_original_id (original_id)
    );
    
    PRINT 'Table CDW_push_arn_cleanup_results created successfully';
END
ELSE
BEGIN
    PRINT 'Table CDW_push_arn_cleanup_results already exists';
END

-- Add a comment to document the table structure
IF EXISTS (SELECT * FROM sys.tables WHERE name = 'CDW_push_arn_cleanup_results')
BEGIN
    EXEC sys.sp_addextendedproperty 
        @name = N'MS_Description',
        @value = N'Stores results of AWS SNS push notification ARN status checks. Used to track which ARNs are active, disabled, or invalid.',
        @level0type = N'SCHEMA', @level0name = N'dbo',
        @level1type = N'TABLE', @level1name = N'CDW_push_arn_cleanup_results';
END

-- Status values documentation:
-- ENABLED: The endpoint is active and receiving notifications
-- DISABLED: The endpoint is disabled (user opted out or app uninstalled)
-- ERROR: There was an error checking the endpoint status
-- NOT_FOUND: The endpoint was not found in AWS Pinpoint