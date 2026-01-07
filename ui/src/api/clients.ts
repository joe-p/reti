import { FEE_SINK } from '@/constants/accounts'
import { StakingPoolClient, StakingPoolFactory } from '@/contracts/StakingPoolClient'
import { ValidatorRegistryClient } from '@/contracts/ValidatorRegistryClient'
import {
  getRetiAppIdFromViteEnvironment,
  getXGovRegistryAppIdFromViteEnvironment,
} from '@/utils/env'
import { getAlgodConfigFromViteEnvironment } from '@/utils/network/getAlgoClientConfigs'
import { AlgorandClient } from '@algorandfoundation/algokit-utils'
// @ts-expect-error module resolution issue
import { XGovRegistryClient } from '@algorandfoundation/xgov/registry'
import { TransactionSigner } from '@algorandfoundation/algokit-utils/transact'

const algodConfig = getAlgodConfigFromViteEnvironment()

export const algorandClient = AlgorandClient.fromConfig({ algodConfig })
  .setDefaultValidityWindow(900)
  .setSuggestedParamsCacheTimeout(1000 * 60 * 5) // 5 minutes

const RETI_APP_ID = BigInt(getRetiAppIdFromViteEnvironment())
const XGOV_REGISTRY_APP_ID = BigInt(getXGovRegistryAppIdFromViteEnvironment())

export function getStakingPoolFactory(): [AlgorandClient, StakingPoolFactory] {
  return [algorandClient, new StakingPoolFactory({ algorand: algorandClient })]
}

export async function getValidatorClient(
  signer: TransactionSigner,
  activeAddress: string,
): Promise<ValidatorRegistryClient> {
  algorandClient.setSigner(activeAddress, signer)
  return algorandClient.client.getTypedAppClientById(ValidatorRegistryClient, {
    defaultSender: activeAddress,
    appId: RETI_APP_ID,
  })
}

export async function getSimulateValidatorClient(
  senderAddr: string = FEE_SINK,
): Promise<ValidatorRegistryClient> {
  return algorandClient.client.getTypedAppClientById(ValidatorRegistryClient, {
    defaultSender: senderAddr,
    appId: RETI_APP_ID,
  })
}

export async function getStakingPoolClient(
  poolAppId: bigint,
  signer: TransactionSigner,
  activeAddress: string,
): Promise<StakingPoolClient> {
  algorandClient.setSigner(activeAddress, signer)
  return algorandClient.client.getTypedAppClientById(StakingPoolClient, {
    defaultSender: activeAddress,
    appId: poolAppId,
  })
}

export async function getSimulateStakingPoolClient(
  poolAppId: bigint,
  senderAddr: string = FEE_SINK,
): Promise<StakingPoolClient> {
  return algorandClient.client.getTypedAppClientById(StakingPoolClient, {
    defaultSender: senderAddr,
    appId: poolAppId,
  })
}

export async function getXGovRegistryClient(
  signer: TransactionSigner,
  activeAddress: string,
): Promise<XGovRegistryClient> {
  algorandClient.setSigner(activeAddress, signer)
  return algorandClient.client.getTypedAppClientById(XGovRegistryClient, {
    defaultSender: activeAddress,
    appId: XGOV_REGISTRY_APP_ID,
  })
}

export async function getSimulateXGovRegistryClient(
  senderAddr: string = FEE_SINK,
): Promise<XGovRegistryClient> {
  return algorandClient.client.getTypedAppClientById(XGovRegistryClient, {
    defaultSender: senderAddr,
    appId: XGOV_REGISTRY_APP_ID,
  })
}
