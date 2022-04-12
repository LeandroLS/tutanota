import {_TypeModel as FileDataDataGetTypModel, createFileDataDataGet} from "../../entities/tutanota/FileDataDataGet"
import {addParamsToUrl, isSuspensionResponse, RestClient} from "../rest/RestClient"
import {encryptBytes, resolveSessionKey} from "../crypto/CryptoFacade"
import type {File as TutanotaFile} from "../../entities/tutanota/File"
import {_TypeModel as FileTypeModel} from "../../entities/tutanota/File"
import {assert, filterInt, neverNull, TypeRef, uint8ArrayToBase64} from "@tutao/tutanota-utils"
import {createFileDataDataPost} from "../../entities/tutanota/FileDataDataPost"
import {GroupType} from "../../common/TutanotaConstants"
import {_TypeModel as FileDataDataReturnTypeModel} from "../../entities/tutanota/FileDataDataReturn"
import {HttpMethod, MediaType, resolveTypeReference} from "../../common/EntityFunctions"
import {assertWorkerOrNode, getHttpOrigin, Mode} from "../../common/Env"
import {handleRestError} from "../../common/error/RestError"
import {convertToDataFile, DataFile} from "../../common/DataFile"
import type {SuspensionHandler} from "../SuspensionHandler"
import {createBlobAccessTokenData} from "../../entities/storage/BlobAccessTokenData"
import type {BlobAccessInfo} from "../../entities/sys/BlobAccessInfo"
import {_TypeModel as BlobDataGetTypeModel, createBlobDataGet} from "../../entities/storage/BlobDataGet"
import {createBlobWriteData} from "../../entities/storage/BlobWriteData"
import {createTypeInfo} from "../../entities/sys/TypeInfo"
import type {TypeModel} from "../../common/EntityTypes"
import {aes128Decrypt, random, sha256Hash, uint8ArrayToKey} from "@tutao/tutanota-crypto"
import type {NativeFileApp} from "../../../native/common/FileApp"
import type {AesApp} from "../../../native/worker/AesApp"
import {InstanceMapper} from "../crypto/InstanceMapper"
import {FileReference} from "../../common/utils/FileUtils";
import {IServiceExecutor} from "../../common/ServiceRequest"
import {FileDataService} from "../../entities/tutanota/Services"
import {BlobAccessTokenService, BlobService} from "../../entities/storage/Services"
import {UserFacade} from "./UserFacade"

assertWorkerOrNode()
const REST_PATH = "/rest/tutanota/filedataservice"
const STORAGE_REST_PATH = `/rest/storage/${BlobService.name}`

export class FileFacade {
	_restClient: RestClient
	_suspensionHandler: SuspensionHandler
	_fileApp: NativeFileApp
	_aesApp: AesApp
	_instanceMapper: InstanceMapper

	constructor(
		private readonly user: UserFacade,
		restClient: RestClient,
		suspensionHandler: SuspensionHandler,
		fileApp: NativeFileApp,
		aesApp: AesApp,
		instanceMapper: InstanceMapper,
		private readonly serviceExecutor: IServiceExecutor,
	) {
		this._restClient = restClient
		this._suspensionHandler = suspensionHandler
		this._fileApp = fileApp
		this._aesApp = aesApp
		this._instanceMapper = instanceMapper
	}

	clearFileData(): Promise<void> {
		return this._fileApp.clearFileData()
	}

	downloadFileContent(file: TutanotaFile): Promise<DataFile> {
		let requestData = createFileDataDataGet()
		requestData.file = file._id
		requestData.base64 = false
		return resolveSessionKey(FileTypeModel, file).then(sessionKey => {
			return this._instanceMapper.encryptAndMapToLiteral(FileDataDataGetTypModel, requestData, null).then(entityToSend => {
				let headers = this.user.createAuthHeaders()

				headers["v"] = FileDataDataGetTypModel.version
				let body = JSON.stringify(entityToSend)
				return this._restClient.request(REST_PATH, HttpMethod.GET, {body, responseType: MediaType.Binary, headers}).then(data => {
					return convertToDataFile(file, aes128Decrypt(neverNull(sessionKey), data))
				})
			})
		})
	}

	async downloadFileContentNative(file: TutanotaFile): Promise<FileReference> {
		assert(env.mode === Mode.App || env.mode === Mode.Desktop, "Environment is not app or Desktop!")

		if (this._suspensionHandler.isSuspended()) {
			return this._suspensionHandler.deferRequest(() => this.downloadFileContentNative(file))
		}

		const requestData = createFileDataDataGet({
			file: file._id,
			base64: false,
		})
		const sessionKey = await resolveSessionKey(FileTypeModel, file)
		const entityToSend = await this._instanceMapper.encryptAndMapToLiteral(FileDataDataGetTypModel, requestData, null)

		const headers = this.user.createAuthHeaders()

		headers["v"] = FileDataDataGetTypModel.version
		const body = JSON.stringify(entityToSend)
		const queryParams = {
			_body: body,
		}
		const url = addParamsToUrl(new URL(getHttpOrigin() + REST_PATH), queryParams)
		const {
			statusCode,
			encryptedFileUri,
			errorId,
			precondition,
			suspensionTime
		} = await this._fileApp.download(url.toString(), file.name, headers)

		if (suspensionTime && isSuspensionResponse(statusCode, suspensionTime)) {
			this._suspensionHandler.activateSuspensionIfInactive(Number(suspensionTime))

			return this._suspensionHandler.deferRequest(() => this.downloadFileContentNative(file))
		} else if (statusCode === 200 && encryptedFileUri != null) {
			const decryptedFileUri = await this._aesApp.aesDecryptFile(neverNull(sessionKey), encryptedFileUri)

			try {
				await this._fileApp.deleteFile(encryptedFileUri)
			} catch (e) {
				console.warn("Failed to delete encrypted file", encryptedFileUri)
			}

			return {
				_type: "FileReference",
				name: file.name,
				mimeType: file.mimeType ?? MediaType.Binary,
				location: decryptedFileUri,
				size: filterInt(file.size),
			}
		} else {
			throw handleRestError(statusCode, ` | GET ${url.toString()} failed to natively download attachment`, errorId, precondition)
		}
	}

	async uploadFileData(dataFile: DataFile, sessionKey: Aes128Key): Promise<Id> {
		const encryptedData = encryptBytes(sessionKey, dataFile.data)
		const fileData = createFileDataDataPost({
			size: dataFile.data.byteLength.toString(),
			group: this.user.getGroupId(GroupType.Mail)  // currently only used for attachments
		})
		const fileDataPostReturn = await this.serviceExecutor.post(FileDataService, fileData, {sessionKey})
		// upload the file content
		let fileDataId = fileDataPostReturn.fileData

		const headers = this.user.createAuthHeaders()
		headers["v"] = FileDataDataReturnTypeModel.version
		await this._restClient
				  .request(
					  REST_PATH,
					  HttpMethod.PUT,
					  {
						  queryParams: {
							  fileDataId: fileDataId,
						  },
						  headers,
						  body: encryptedData,
						  responseType: MediaType.Binary,
					  },
				  )
		return fileDataId
	}

	/**
	 * Does not cleanup uploaded files. This is a responsibility of the caller
	 */
	async uploadFileDataNative(fileReference: FileReference, sessionKey: Aes128Key): Promise<Id> {
		if (this._suspensionHandler.isSuspended()) {
			return this._suspensionHandler.deferRequest(() => this.uploadFileDataNative(fileReference, sessionKey))
		}

		const encryptedFileInfo = await this._aesApp.aesEncryptFile(sessionKey, fileReference.location, random.generateRandomData(16))
		const fileData = createFileDataDataPost({
			size: encryptedFileInfo.unencSize.toString(),
			group: this.user.getGroupId(GroupType.Mail), // currently only used for attachments
		})
		const fileDataPostReturn = await this.serviceExecutor.post(FileDataService, fileData, {sessionKey})
		const fileDataId = fileDataPostReturn.fileData

		const headers = this.user.createAuthHeaders()

		headers["v"] = FileDataDataReturnTypeModel.version
		const url = addParamsToUrl(new URL(getHttpOrigin() + "/rest/tutanota/filedataservice"), {
			fileDataId,
		})
		const {
			statusCode,
			errorId,
			precondition,
			suspensionTime
		} = await this._fileApp.upload(encryptedFileInfo.uri, url.toString(), headers)

		if (statusCode === 200) {
			return fileDataId
		} else if (suspensionTime && isSuspensionResponse(statusCode, suspensionTime)) {
			this._suspensionHandler.activateSuspensionIfInactive(Number(suspensionTime))

			return this._suspensionHandler.deferRequest(() => this.uploadFileDataNative(fileReference, sessionKey))
		} else {
			throw handleRestError(statusCode, ` | PUT ${url.toString()} failed to natively upload attachment`, errorId, precondition)
		}
	}

	/**
	 * @returns blobReferenceToken
	 */
	async uploadBlob(
		instance: {
			_type: TypeRef<any>
		},
		blobData: Uint8Array,
		ownerGroupId: Id,
	): Promise<Uint8Array> {
		const typeModel = await resolveTypeReference(instance._type)
		const sessionKey = neverNull(await resolveSessionKey(typeModel, instance))
		const encryptedData = encryptBytes(sessionKey, blobData)
		const blobHash = uint8ArrayToBase64(sha256Hash(encryptedData).slice(0, 6))
		const {storageAccessToken, servers} = await this.getUploadToken(typeModel, ownerGroupId)
		const headers = Object.assign(
			{
				storageAccessToken,
				v: BlobDataGetTypeModel.version,
			},
			this.user.createAuthHeaders(),
		)
		return this._restClient.request(
			STORAGE_REST_PATH,
			HttpMethod.PUT,
			{
				queryParams: {
					blobHash
				},
				headers,
				body: encryptedData,
				responseType: MediaType.Binary,
				baseUrl: servers[0].url,
			},
		)
	}

	async downloadBlob(archiveId: Id, blobId: Id, key: Uint8Array): Promise<Uint8Array> {
		const {storageAccessToken, servers} = await this.getDownloadToken(archiveId)
		const headers = Object.assign(
			{
				storageAccessToken,
				v: BlobDataGetTypeModel.version,
			},
			this.user.createAuthHeaders(),
		)
		const getData = createBlobDataGet({
			archiveId,
			blobId,
		})
		const literalGetData = await this._instanceMapper.encryptAndMapToLiteral(BlobDataGetTypeModel, getData, null)
		const body = JSON.stringify(literalGetData)
		const data = await this._restClient.request(STORAGE_REST_PATH, HttpMethod.GET, {
			headers,
			body,
			responseType: MediaType.Binary,
			baseUrl: servers[0].url,
		})
		return aes128Decrypt(uint8ArrayToKey(key), data)
	}

	async getUploadToken(typeModel: TypeModel, ownerGroupId: Id): Promise<BlobAccessInfo> {
		const tokenRequest = createBlobAccessTokenData({
			write: createBlobWriteData({
				type: createTypeInfo({
					application: typeModel.app,
					typeId: String(typeModel.id),
				}),
				archiveOwnerGroup: ownerGroupId,
			}),
		})
		const {blobAccessInfo} = await this.serviceExecutor.post(BlobAccessTokenService, tokenRequest)
		return blobAccessInfo
	}

	async getDownloadToken(readArchiveId: Id): Promise<BlobAccessInfo> {
		const tokenRequest = createBlobAccessTokenData({
			readArchiveId,
		})
		const {blobAccessInfo} = await this.serviceExecutor.post(BlobAccessTokenService, tokenRequest)
		return blobAccessInfo
	}
}