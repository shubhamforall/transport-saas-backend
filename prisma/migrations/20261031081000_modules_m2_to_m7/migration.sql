-- AlterTable
ALTER TABLE `tenants` ADD COLUMN `defaultPaymentTermsDays` INTEGER NOT NULL DEFAULT 30,
    ADD COLUMN `defaultSacCode` VARCHAR(8) NULL,
    ADD COLUMN `defaultTaxRateBps` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `invoicePrefix` VARCHAR(5) NOT NULL DEFAULT 'INV',
    ADD COLUMN `invoiceTerms` TEXT NULL,
    ADD COLUMN `jobNumberPrefix` VARCHAR(10) NOT NULL DEFAULT 'JOB-',
    ADD COLUMN `paymentInstructions` TEXT NULL,
    ADD COLUMN `statusReason` VARCHAR(500) NULL;

-- CreateTable
CREATE TABLE `customers` (
    `id` VARCHAR(30) NOT NULL,
    `tenantId` VARCHAR(30) NOT NULL,
    `customerType` ENUM('BUSINESS', 'INDIVIDUAL') NOT NULL DEFAULT 'BUSINESS',
    `name` VARCHAR(200) NOT NULL,
    `contactPerson` VARCHAR(120) NULL,
    `email` VARCHAR(254) NULL,
    `phone` VARCHAR(20) NULL,
    `addressLine1` VARCHAR(200) NULL,
    `addressLine2` VARCHAR(200) NULL,
    `city` VARCHAR(100) NULL,
    `state` VARCHAR(100) NULL,
    `stateCode` CHAR(2) NULL,
    `postalCode` VARCHAR(10) NULL,
    `country` CHAR(2) NOT NULL DEFAULT 'IN',
    `gstin` VARCHAR(15) NULL,
    `paymentTermsDays` INTEGER NULL,
    `notes` TEXT NULL,
    `status` ENUM('ACTIVE', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `customers_tenantId_status_name_idx`(`tenantId`, `status`, `name`),
    INDEX `customers_tenantId_gstin_idx`(`tenantId`, `gstin`),
    INDEX `customers_tenantId_phone_idx`(`tenantId`, `phone`),
    UNIQUE INDEX `customers_tenantId_id_key`(`tenantId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `vehicles` (
    `id` VARCHAR(30) NOT NULL,
    `tenantId` VARCHAR(30) NOT NULL,
    `registrationNumberNormalized` VARCHAR(15) NOT NULL,
    `registrationNumberDisplay` VARCHAR(20) NOT NULL,
    `vehicleType` ENUM('MINI_TRUCK', 'LCV', 'MEDIUM_TRUCK', 'HEAVY_TRUCK', 'TRAILER', 'CONTAINER_TRUCK', 'PICKUP', 'OTHER') NOT NULL,
    `makeModel` VARCHAR(100) NULL,
    `capacityMilli` INTEGER NULL,
    `capacityUnit` ENUM('TONNES', 'KG', 'CUBIC_METRES') NULL,
    `ownershipType` ENUM('OWNED', 'LEASED', 'ATTACHED', 'OTHER') NULL,
    `notes` TEXT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `vehicles_tenantId_status_idx`(`tenantId`, `status`),
    UNIQUE INDEX `vehicles_tenantId_registrationNumberNormalized_key`(`tenantId`, `registrationNumberNormalized`),
    UNIQUE INDEX `vehicles_tenantId_id_key`(`tenantId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tenant_sequences` (
    `id` VARCHAR(30) NOT NULL,
    `tenantId` VARCHAR(30) NOT NULL,
    `name` VARCHAR(32) NOT NULL,
    `nextNumber` INTEGER NOT NULL DEFAULT 1,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `tenant_sequences_tenantId_name_key`(`tenantId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `transport_jobs` (
    `id` VARCHAR(30) NOT NULL,
    `tenantId` VARCHAR(30) NOT NULL,
    `jobNumber` VARCHAR(30) NOT NULL,
    `customerId` VARCHAR(30) NOT NULL,
    `vehicleId` VARCHAR(30) NULL,
    `bookingDate` DATE NOT NULL,
    `originAddress` VARCHAR(300) NULL,
    `originCity` VARCHAR(100) NOT NULL,
    `destinationAddress` VARCHAR(300) NULL,
    `destinationCity` VARCHAR(100) NOT NULL,
    `plannedPickupDate` DATE NULL,
    `actualPickupDate` DATE NULL,
    `plannedDeliveryDate` DATE NULL,
    `actualDeliveryDate` DATE NULL,
    `driverName` VARCHAR(120) NULL,
    `driverPhone` VARCHAR(20) NULL,
    `goodsDescription` VARCHAR(500) NOT NULL,
    `quantityMilli` INTEGER NULL,
    `quantityUnit` VARCHAR(20) NULL,
    `lrNumber` VARCHAR(50) NULL,
    `freightAmountMinor` INTEGER NOT NULL,
    `discountAmountMinor` INTEGER NOT NULL DEFAULT 0,
    `taxRateBps` INTEGER NULL,
    `status` ENUM('DRAFT', 'BOOKED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED') NOT NULL DEFAULT 'BOOKED',
    `internalNotes` TEXT NULL,
    `createdByUserId` VARCHAR(30) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `transport_jobs_tenantId_status_bookingDate_idx`(`tenantId`, `status`, `bookingDate`),
    INDEX `transport_jobs_tenantId_customerId_idx`(`tenantId`, `customerId`),
    INDEX `transport_jobs_tenantId_vehicleId_idx`(`tenantId`, `vehicleId`),
    INDEX `transport_jobs_tenantId_actualDeliveryDate_idx`(`tenantId`, `actualDeliveryDate`),
    UNIQUE INDEX `transport_jobs_tenantId_jobNumber_key`(`tenantId`, `jobNumber`),
    UNIQUE INDEX `transport_jobs_tenantId_id_key`(`tenantId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `transport_job_charges` (
    `id` VARCHAR(30) NOT NULL,
    `tenantId` VARCHAR(30) NOT NULL,
    `transportJobId` VARCHAR(30) NOT NULL,
    `description` VARCHAR(200) NOT NULL,
    `amountMinor` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `transport_job_charges_tenantId_transportJobId_idx`(`tenantId`, `transportJobId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_status_events` (
    `id` VARCHAR(30) NOT NULL,
    `tenantId` VARCHAR(30) NOT NULL,
    `transportJobId` VARCHAR(30) NOT NULL,
    `fromStatus` ENUM('DRAFT', 'BOOKED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED') NULL,
    `toStatus` ENUM('DRAFT', 'BOOKED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED') NOT NULL,
    `note` VARCHAR(500) NULL,
    `actorUserId` VARCHAR(30) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `job_status_events_tenantId_transportJobId_createdAt_idx`(`tenantId`, `transportJobId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoices` (
    `id` VARCHAR(30) NOT NULL,
    `tenantId` VARCHAR(30) NOT NULL,
    `invoiceNumber` VARCHAR(16) NULL,
    `customerId` VARCHAR(30) NOT NULL,
    `invoiceDate` DATE NOT NULL,
    `dueDate` DATE NULL,
    `status` ENUM('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `taxType` ENUM('NONE', 'INTRA_STATE', 'INTER_STATE') NOT NULL DEFAULT 'NONE',
    `placeOfSupplyStateCode` CHAR(2) NULL,
    `customerSnapshot` JSON NULL,
    `companySnapshot` JSON NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'INR',
    `subtotalMinor` INTEGER NOT NULL DEFAULT 0,
    `discountMinor` INTEGER NOT NULL DEFAULT 0,
    `taxableMinor` INTEGER NOT NULL DEFAULT 0,
    `cgstMinor` INTEGER NOT NULL DEFAULT 0,
    `sgstMinor` INTEGER NOT NULL DEFAULT 0,
    `igstMinor` INTEGER NOT NULL DEFAULT 0,
    `taxTotalMinor` INTEGER NOT NULL DEFAULT 0,
    `grandTotalMinor` INTEGER NOT NULL DEFAULT 0,
    `amountPaidMinor` INTEGER NOT NULL DEFAULT 0,
    `notes` TEXT NULL,
    `terms` TEXT NULL,
    `createdByUserId` VARCHAR(30) NOT NULL,
    `issuedAt` DATETIME(3) NULL,
    `issuedByUserId` VARCHAR(30) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelledByUserId` VARCHAR(30) NULL,
    `cancellationReason` VARCHAR(500) NULL,
    `lastEmailedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `invoices_tenantId_status_invoiceDate_idx`(`tenantId`, `status`, `invoiceDate`),
    INDEX `invoices_tenantId_customerId_idx`(`tenantId`, `customerId`),
    INDEX `invoices_tenantId_dueDate_idx`(`tenantId`, `dueDate`),
    UNIQUE INDEX `invoices_tenantId_invoiceNumber_key`(`tenantId`, `invoiceNumber`),
    UNIQUE INDEX `invoices_tenantId_id_key`(`tenantId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoice_items` (
    `id` VARCHAR(30) NOT NULL,
    `tenantId` VARCHAR(30) NOT NULL,
    `invoiceId` VARCHAR(30) NOT NULL,
    `description` VARCHAR(500) NOT NULL,
    `sacCode` VARCHAR(8) NULL,
    `quantityMilli` INTEGER NOT NULL,
    `unitPriceMinor` INTEGER NOT NULL,
    `discountMinor` INTEGER NOT NULL DEFAULT 0,
    `taxableAmountMinor` INTEGER NOT NULL,
    `taxRateBps` INTEGER NOT NULL DEFAULT 0,
    `taxAmountMinor` INTEGER NOT NULL,
    `lineTotalMinor` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `invoice_items_tenantId_invoiceId_idx`(`tenantId`, `invoiceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoice_jobs` (
    `id` VARCHAR(30) NOT NULL,
    `tenantId` VARCHAR(30) NOT NULL,
    `invoiceId` VARCHAR(30) NOT NULL,
    `transportJobId` VARCHAR(30) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `invoice_jobs_tenantId_invoiceId_idx`(`tenantId`, `invoiceId`),
    UNIQUE INDEX `invoice_jobs_tenantId_transportJobId_key`(`tenantId`, `transportJobId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoice_sequences` (
    `id` VARCHAR(30) NOT NULL,
    `tenantId` VARCHAR(30) NOT NULL,
    `financialYear` VARCHAR(5) NOT NULL,
    `nextNumber` INTEGER NOT NULL DEFAULT 1,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `invoice_sequences_tenantId_financialYear_key`(`tenantId`, `financialYear`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payments` (
    `id` VARCHAR(30) NOT NULL,
    `tenantId` VARCHAR(30) NOT NULL,
    `customerId` VARCHAR(30) NOT NULL,
    `paymentDate` DATE NOT NULL,
    `amountMinor` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'INR',
    `method` ENUM('CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE', 'OTHER') NOT NULL,
    `reference` VARCHAR(100) NULL,
    `notes` TEXT NULL,
    `status` ENUM('RECORDED', 'VOIDED') NOT NULL DEFAULT 'RECORDED',
    `recordedByUserId` VARCHAR(30) NOT NULL,
    `voidedAt` DATETIME(3) NULL,
    `voidedByUserId` VARCHAR(30) NULL,
    `voidReason` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `payments_tenantId_paymentDate_idx`(`tenantId`, `paymentDate`),
    INDEX `payments_tenantId_customerId_idx`(`tenantId`, `customerId`),
    UNIQUE INDEX `payments_tenantId_id_key`(`tenantId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_allocations` (
    `id` VARCHAR(30) NOT NULL,
    `tenantId` VARCHAR(30) NOT NULL,
    `paymentId` VARCHAR(30) NOT NULL,
    `invoiceId` VARCHAR(30) NOT NULL,
    `allocatedAmountMinor` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payment_allocations_tenantId_invoiceId_idx`(`tenantId`, `invoiceId`),
    UNIQUE INDEX `payment_allocations_paymentId_invoiceId_key`(`paymentId`, `invoiceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `email_logs` (
    `id` VARCHAR(30) NOT NULL,
    `tenantId` VARCHAR(30) NULL,
    `invoiceId` VARCHAR(30) NULL,
    `kind` VARCHAR(32) NOT NULL,
    `recipient` VARCHAR(254) NOT NULL,
    `subject` VARCHAR(300) NOT NULL,
    `status` ENUM('SENDING', 'SENT', 'FAILED') NOT NULL DEFAULT 'SENDING',
    `providerMessageId` VARCHAR(255) NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `lastErrorSafe` VARCHAR(300) NULL,
    `sentAt` DATETIME(3) NULL,
    `createdByUserId` VARCHAR(30) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `email_logs_tenantId_invoiceId_createdAt_idx`(`tenantId`, `invoiceId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `password_reset_tokens` (
    `id` VARCHAR(30) NOT NULL,
    `userId` VARCHAR(30) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `password_reset_tokens_tokenHash_key`(`tokenHash`),
    INDEX `password_reset_tokens_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invitations` (
    `id` VARCHAR(30) NOT NULL,
    `tenantId` VARCHAR(30) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `role` ENUM('OWNER', 'ADMIN', 'OPERATIONS', 'ACCOUNTS', 'VIEWER') NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `acceptedAt` DATETIME(3) NULL,
    `acceptedUserId` VARCHAR(30) NULL,
    `revokedAt` DATETIME(3) NULL,
    `invitedByUserId` VARCHAR(30) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `invitations_tokenHash_key`(`tokenHash`),
    INDEX `invitations_tenantId_email_idx`(`tenantId`, `email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plans` (
    `id` VARCHAR(30) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `description` VARCHAR(300) NULL,
    `priceMinor` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'INR',
    `billingInterval` ENUM('MONTHLY', 'YEARLY') NOT NULL DEFAULT 'MONTHLY',
    `limitsJson` JSON NOT NULL,
    `featuresJson` JSON NULL,
    `razorpayPlanId` VARCHAR(64) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `plans_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscriptions` (
    `id` VARCHAR(30) NOT NULL,
    `tenantId` VARCHAR(30) NOT NULL,
    `planId` VARCHAR(30) NOT NULL,
    `provider` ENUM('NONE', 'RAZORPAY', 'MANUAL') NOT NULL DEFAULT 'NONE',
    `providerCustomerId` VARCHAR(64) NULL,
    `providerSubscriptionId` VARCHAR(64) NULL,
    `status` ENUM('TRIAL', 'PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED') NOT NULL,
    `trialEndsAt` DATETIME(3) NULL,
    `currentPeriodStart` DATETIME(3) NULL,
    `currentPeriodEnd` DATETIME(3) NULL,
    `cancelAtPeriodEnd` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `subscriptions_providerSubscriptionId_key`(`providerSubscriptionId`),
    INDEX `subscriptions_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
    INDEX `subscriptions_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscription_webhook_events` (
    `id` VARCHAR(30) NOT NULL,
    `provider` ENUM('NONE', 'RAZORPAY', 'MANUAL') NOT NULL,
    `providerEventId` VARCHAR(100) NOT NULL,
    `eventType` VARCHAR(100) NOT NULL,
    `status` ENUM('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED') NOT NULL DEFAULT 'RECEIVED',
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,
    `safeError` VARCHAR(300) NULL,

    INDEX `subscription_webhook_events_receivedAt_idx`(`receivedAt`),
    UNIQUE INDEX `subscription_webhook_events_provider_providerEventId_key`(`provider`, `providerEventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `customers` ADD CONSTRAINT `customers_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vehicles` ADD CONSTRAINT `vehicles_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tenant_sequences` ADD CONSTRAINT `tenant_sequences_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `transport_jobs` ADD CONSTRAINT `transport_jobs_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `transport_jobs` ADD CONSTRAINT `transport_jobs_tenantId_customerId_fkey` FOREIGN KEY (`tenantId`, `customerId`) REFERENCES `customers`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `transport_jobs` ADD CONSTRAINT `transport_jobs_vehicleId_fkey` FOREIGN KEY (`vehicleId`) REFERENCES `vehicles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `transport_job_charges` ADD CONSTRAINT `transport_job_charges_tenantId_transportJobId_fkey` FOREIGN KEY (`tenantId`, `transportJobId`) REFERENCES `transport_jobs`(`tenantId`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `job_status_events` ADD CONSTRAINT `job_status_events_tenantId_transportJobId_fkey` FOREIGN KEY (`tenantId`, `transportJobId`) REFERENCES `transport_jobs`(`tenantId`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_tenantId_customerId_fkey` FOREIGN KEY (`tenantId`, `customerId`) REFERENCES `customers`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoice_items` ADD CONSTRAINT `invoice_items_tenantId_invoiceId_fkey` FOREIGN KEY (`tenantId`, `invoiceId`) REFERENCES `invoices`(`tenantId`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoice_jobs` ADD CONSTRAINT `invoice_jobs_tenantId_invoiceId_fkey` FOREIGN KEY (`tenantId`, `invoiceId`) REFERENCES `invoices`(`tenantId`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoice_jobs` ADD CONSTRAINT `invoice_jobs_tenantId_transportJobId_fkey` FOREIGN KEY (`tenantId`, `transportJobId`) REFERENCES `transport_jobs`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoice_sequences` ADD CONSTRAINT `invoice_sequences_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_tenantId_customerId_fkey` FOREIGN KEY (`tenantId`, `customerId`) REFERENCES `customers`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_allocations` ADD CONSTRAINT `payment_allocations_tenantId_paymentId_fkey` FOREIGN KEY (`tenantId`, `paymentId`) REFERENCES `payments`(`tenantId`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_allocations` ADD CONSTRAINT `payment_allocations_tenantId_invoiceId_fkey` FOREIGN KEY (`tenantId`, `invoiceId`) REFERENCES `invoices`(`tenantId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `email_logs` ADD CONSTRAINT `email_logs_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `email_logs` ADD CONSTRAINT `email_logs_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `password_reset_tokens` ADD CONSTRAINT `password_reset_tokens_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `plans`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
