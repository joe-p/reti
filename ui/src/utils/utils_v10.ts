import * as algosdk from 'algosdk'
import {
  AddressWithTransactionSigner,
  decodeSignedTransaction,
  decodeTransaction,
  encodeSignedTransaction,
  encodeTransactionRaw,
  TransactionSigner,
  type SignedTransaction,
  type Transaction,
} from '@algorandfoundation/algokit-utils/transact'
import { AlgodClient } from '@algorandfoundation/algokit-utils/algod-client'

export function sdkTxnToAlgokit(txn: algosdk.Transaction): Transaction {
  return decodeTransaction(algosdk.encodeMsgpack(txn))
}

export function algokitTxnToSdk(txn: Transaction): algosdk.Transaction {
  return algosdk.decodeUnsignedTransaction(encodeTransactionRaw(txn))
}

export function signedAlgokitTxnToSdk(signedTxn: algosdk.SignedTransaction): SignedTransaction {
  return decodeSignedTransaction(algosdk.encodeMsgpack(signedTxn))
}

export function signedSdkTxnToAlgokit(signedTxn: SignedTransaction): algosdk.SignedTransaction {
  return algosdk.decodeSignedTransaction(encodeSignedTransaction(signedTxn))
}

// MIGRATION TODO: Add function for signing single txn
export async function signTransaction(txn: Transaction, signer: AddressWithTransactionSigner) {
  return await signer.signer([txn], [0])
}

export function algokitSignerToSdk(algokitSigner: TransactionSigner): algosdk.TransactionSigner {
  return async (txns: algosdk.Transaction[], indexesToSign: number[]) => {
    const algokitTxns = txns.map((txn) => sdkTxnToAlgokit(txn))
    const signedTxns = await algokitSigner(algokitTxns, indexesToSign)
    return signedTxns
  }
}

export function algokitAlgodToSdk(algokitAlgod: AlgodClient): algosdk.Algodv2 {
  return new algosdk.Algodv2(
    algokitAlgod.httpRequest.config.headers?.['X-Algo-API-Token'] ?? '',
    algokitAlgod.httpRequest.config.baseUrl,
    algokitAlgod.httpRequest.config.port,
  )
}
