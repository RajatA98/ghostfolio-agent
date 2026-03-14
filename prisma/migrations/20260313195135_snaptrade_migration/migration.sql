/*
  Warnings:

  - You are about to drop the column `ghostfolioAccountId` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `ghostfolioJwt` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `ghostfolioJwtExpiresAt` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `ghostfolioSecurityToken` on the `User` table. All the data in the column will be lost.
  - You are about to drop the `Order` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PlaidItem` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_userId_fkey";

-- DropForeignKey
ALTER TABLE "PlaidItem" DROP CONSTRAINT "PlaidItem_userId_fkey";

-- DropIndex
DROP INDEX "User_ghostfolioAccountId_key";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "ghostfolioAccountId",
DROP COLUMN "ghostfolioJwt",
DROP COLUMN "ghostfolioJwtExpiresAt",
DROP COLUMN "ghostfolioSecurityToken";

-- DropTable
DROP TABLE "Order";

-- DropTable
DROP TABLE "PlaidItem";

-- CreateTable
CREATE TABLE "BrokerageConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "snaptradeUserId" TEXT NOT NULL,
    "userSecretEncrypted" TEXT NOT NULL,
    "institutionName" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrokerageConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BrokerageConnection_userId_idx" ON "BrokerageConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BrokerageConnection_userId_snaptradeUserId_key" ON "BrokerageConnection"("userId", "snaptradeUserId");

-- AddForeignKey
ALTER TABLE "BrokerageConnection" ADD CONSTRAINT "BrokerageConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
