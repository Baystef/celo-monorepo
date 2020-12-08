import { eqAddress, Err, Ok } from '@celo/base'
import { Address, ContractKit } from '@celo/contractkit'
import {
  FetchError,
  InvalidSignature,
  OffchainDataWrapper,
  OffchainErrors,
} from '@celo/contractkit/src/identity/offchain-data-wrapper'
import { PrivateNameAccessor } from '@celo/contractkit/src/identity/offchain/accessors/name'
import { buildEIP712TypedData, resolvePath } from '@celo/contractkit/src/identity/offchain/utils'
import { UnlockableWallet } from '@celo/contractkit/src/wallets/wallet'
import {
  ensureLeading0x,
  normalizeAddressWith0x,
  privateKeyToAddress,
  toChecksumAddress,
} from '@celo/utils/src/address'
import { recoverEIP712TypedDataSigner } from '@celo/utils/src/signatureUtils'
import { SignedPostPolicyV4Output } from '@google-cloud/storage'
import * as t from 'io-ts'
import fetch from 'node-fetch'
import { call, put, select } from 'redux-saga/effects'
import RNFetchBlob from 'rn-fetch-blob'
import { profileUploaded } from 'src/account/actions'
import { nameSelector } from 'src/account/selectors'
import { ErrorMessages } from 'src/app/ErrorMessages'
import Logger from 'src/utils/Logger'
import { getContractKit, getWallet } from 'src/web3/contracts'
import { currentAccountSelector, dataEncryptionKeySelector } from 'src/web3/selectors'

const TAG = 'account/profileInfo'
const BUCKET_URL = 'https://storage.googleapis.com/isabellewei-test/'

// class ValoraStorageWriter extends LocalStorageWriter {
//   private readonly account: string

//   constructor(readonly local: string, bucket: string) {
//     super(local)
//     this.account = bucket
//   }

//   // TEMP for testing
//   async write(data: Buffer, dataPath: string): Promise<void> {
//     const response = await fetch(`${BUCKET_URL}${this.account}${dataPath}`, {
//       method: 'PUT',
//       headers: {
//         'Content-Type': 'application/octet-stream',
//       },
//       body: data,
//     })
//     if (!response.ok) {
//       throw Error('Unable to write')
//     }
//   }
// }

const authorizerUrl = 'https://us-central1-celo-testnet.cloudfunctions.net/valora-upload-authorizer'
const valoraMetadataUrl = 'https://storage.googleapis.com/celo-test-alexh-bucket'

async function makeCall(data: any, signature: string): Promise<SignedPostPolicyV4Output[]> {
  const response = await fetch(authorizerUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Signature: signature,
    },
    body: JSON.stringify(data),
  })

  if (response.status >= 400) {
    throw new Error(await response.text())
  }

  return response.json()
}

class UploadServiceDataWrapper implements OffchainDataWrapper {
  signer: Address
  self: Address

  constructor(readonly kit: ContractKit, address: Address) {
    this.signer = this.self = address
  }

  async writeDataTo(
    data: Buffer,
    signature: Buffer,
    dataPath: string
  ): Promise<OffchainErrors | void> {
    const dataPayloads = [data, signature]
    const signedUrlsPayload = [
      {
        path: dataPath,
      },
      {
        path: `${dataPath}.signature`,
      },
    ]

    const hexPayload = ensureLeading0x(
      Buffer.from(JSON.stringify(signedUrlsPayload)).toString('hex')
    )
    const authorization = await this.kit.getWallet().signPersonalMessage(this.signer, hexPayload)
    const signedUrls = await makeCall(signedUrlsPayload, authorization)
    const writeError = await Promise.all(
      signedUrls.map(({ url, fields }, i) => {
        const formData = []
        for (const name of Object.keys(fields)) {
          formData.push({ name, data: fields[name] })
        }
        formData.push({ name: 'file', data: dataPayloads[i] })
        console.log(formData)

        return RNFetchBlob.fetch(
          'POST',
          url,
          {
            'Content-Type': 'multipart/form-data',
          },
          formData
        ).then((x) => {
          console.log('resp')
          console.log(x)
          x.text()
        })
      })
    )
    console.log(writeError)
  }

  async readDataFromAsResult<DataType>(
    account: Address,
    dataPath: string,
    _checkOffchainSigners: boolean,
    type?: t.Type<DataType>
  ): Promise<Result<Buffer, OffchainErrors>> {
    let dataResponse, signatureResponse

    const accountRoot = `${valoraMetadataUrl}/${toChecksumAddress(account)}`
    try {
      ;[dataResponse, signatureResponse] = await Promise.all([
        fetch(resolvePath(accountRoot, dataPath)),
        fetch(resolvePath(accountRoot, `${dataPath}.signature`)),
      ])
    } catch (error) {
      return Err(new FetchError(error))
    }

    if (!dataResponse.ok) {
      return Err(new FetchError(new Error(dataResponse.statusText)))
    }
    if (!signatureResponse.ok) {
      return Err(new FetchError(new Error(signatureResponse.statusText)))
    }

    const [dataBody, signatureBody] = await Promise.all([
      dataResponse.arrayBuffer(),
      signatureResponse.arrayBuffer(),
    ])

    const body = Buffer.from(dataBody)
    const signature = ensureLeading0x(Buffer.from(signatureBody).toString('hex'))

    const toParse = type ? JSON.parse(body.toString()) : body
    const typedData = await buildEIP712TypedData(this, dataPath, toParse, type)
    const guessedSigner = recoverEIP712TypedDataSigner(typedData, signature)
    if (eqAddress(guessedSigner, account)) {
      return Ok(body)
    }

    return Err(new InvalidSignature())
  }
}

// requires that the DEK has already been registered
export function* uploadProfileInfo() {
  // const isAlreadyUploaded = yield select(isProfileUploadedSelector)
  // if (isAlreadyUploaded) {
  //   return
  // }
  try {
    try {
      const privateDataKey: string | null = yield select(dataEncryptionKeySelector)
      if (!privateDataKey) {
        throw new Error('No data key in store. Should never happen.')
      }
      const dataKeyaddress = normalizeAddressWith0x(
        privateKeyToAddress(ensureLeading0x(privateDataKey))
      )
      const wallet: UnlockableWallet = yield call(getWallet)
      // yield call([wallet, wallet.addAccount], privateDataKey, '')
      // unlocking with a duration of 0 should unlock the DEK indefinitely
      yield call([wallet, wallet.unlockAccount], dataKeyaddress, '', 0)
    } catch (e) {
      if (e === ErrorMessages.GETH_ACCOUNT_ALREADY_EXISTS) {
        Logger.warn(TAG + '@uploadProfileInfo', 'Attempted to import DEK to wallet again')
      } else {
        Logger.error(TAG + '@uploadProfileInfo', 'Error importing DEK to wallet')
        throw e
      }
    }

    // yield call(addMetadataClaim)
    yield call(uploadName)

    yield put(profileUploaded())
    // TODO: add analytics
  } catch (e) {
    Logger.error(TAG + '@uploadProfileInfo', 'Error uploading profile', e)
    // TODO
  }
}

// export function* addMetadataClaim() {
//   try {
//     const contractKit = yield call(getContractKit)
//     const account = yield select(currentAccountSelector)
//     const metadata = IdentityMetadataWrapper.fromEmpty(account)
//     yield call(
//       [metadata, 'addClaim'],
//       createStorageClaim(BUCKET_URL),
//       NativeSigner(contractKit.web3.eth.sign, account)
//     )
//     Logger.info(TAG + '@addMetadataClaim' + 'created storage claim on chain')
//     yield call(writeToGCPBucket, metadata.toString(), `${account}/metadata.json`)
//     Logger.info(TAG + '@addMetadataClaim' + 'uploaded metadata.json')
//     const accountsWrapper: AccountsWrapper = yield call([
//       contractKit.contracts,
//       contractKit.contracts.getAccounts,
//     ])
//     const setAccountTx = accountsWrapper.setMetadataURL(`${BUCKET_URL}${account}/metadata.json`)
//     const context = newTransactionContext(TAG, 'Set metadata URL')
//     yield call(sendTransaction, setAccountTx.txo, account, context)
//     Logger.info(TAG + '@addMetadataClaim' + 'set metadata URL')
//   } catch (error) {
//     Logger.error(`${TAG}/addMetadataClaim`, 'Could not add metadata claim', error)
//     throw error
//   }
// }

// TEMP for testing
// async function writeToGCPBucket(data: string, dataPath: string) {
//   const response = await fetch(`${BUCKET_URL}${dataPath}`, {
//     method: 'PUT',
//     headers: {
//       'Content-Type': 'application/json',
//     },
//     body: data,
//   })
//   if (!response.ok) {
//     console.log(response.statusText)
//     throw Error('Unable to claim metadata')
//   }
// }

export function* uploadName() {
  const contractKit = yield call(getContractKit)
  const account = yield select(currentAccountSelector)
  const name = yield select(nameSelector)
  console.log('uploading name')
  // const storageWriter = new ValoraStorageWriter(`/tmp/${account}`, account)
  const offchainWrapper = new UploadServiceDataWrapper(contractKit, account)
  // offchainWrapper.storageWriter = storageWriter
  const nameAccessor = new PrivateNameAccessor(offchainWrapper)
  console.log('writing name')

  // const writeError = yield call([nameAccessor, 'write'], { name }, [])
  // nameAccessor.write({name}, [])
  const writeError = yield call(() => nameAccessor.write({ name }, []))
  Logger.info(TAG + '@uploadName' + 'uploaded name')

  if (writeError) {
    Logger.error(TAG + '@uploadName', writeError)
    throw Error('Unable to write data')
  }
}

// this function gives permission to the recipient to view the user's profile info
export function* uploadSymmetricKeys(recipientAddresses: string[]) {
  // TODO: check if key for user already exists, skip if yes
  const account = yield select(currentAccountSelector)
  const contractKit = yield call(getContractKit)

  const privateDataKey: string | null = yield select(dataEncryptionKeySelector)
  if (!privateDataKey) {
    throw new Error('No data key in store. Should never happen.')
  }
  const dataKeyaddress = normalizeAddressWith0x(
    privateKeyToAddress(ensureLeading0x(privateDataKey))
  )
  const wallet: UnlockableWallet = yield call(getWallet)
  // unlocking with a duration of 0 should unlock the DEK indefinitely
  yield call([wallet, wallet.unlockAccount], dataKeyaddress, '', 0)

  // const storageWriter = new ValoraStorageWriter(`/tmp/${account}`, account)
  const offchainWrapper = new UploadServiceDataWrapper(contractKit, account)
  // offchainWrapper.storageWriter = storageWriter
  const nameAccessor = new PrivateNameAccessor(offchainWrapper)

  // TODO: use account address instead of wallet address

  const writeError = yield call([nameAccessor, 'writeKeys'], { name }, recipientAddresses)
  Logger.info(TAG + '@uploadSymmetricKeys', 'uploaded symmetric keys for ' + recipientAddresses)

  if (writeError) {
    Logger.error(TAG + '@uploadSymmetricKeys', writeError)
    throw Error('Unable to write keys')
  }
}

export function* getProfileInfo(address: string) {
  const account = yield select(currentAccountSelector)
  const contractKit = yield call(getContractKit)

  const privateDataKey: string | null = yield select(dataEncryptionKeySelector)
  if (!privateDataKey) {
    throw new Error('No data key in store. Should never happen.')
  }
  const dataKeyaddress = normalizeAddressWith0x(
    privateKeyToAddress(ensureLeading0x(privateDataKey))
  )
  const wallet: UnlockableWallet = yield call(getWallet)
  // unlocking with a duration of 0 should unlock the DEK indefinitely
  yield call([wallet, wallet.unlockAccount], dataKeyaddress, '', 0)

  const offchainWrapper = new UploadServiceDataWrapper(contractKit, account)
  const nameAccessor = new PrivateNameAccessor(offchainWrapper)
  console.log('READING NAME FOR', address)
  try {
    const result = yield call([nameAccessor, 'read'], address)
    console.log(result)
    return result
  } catch (error) {
    console.log(error)
    Logger.warn("can't fetch name for", address)
  }
}
