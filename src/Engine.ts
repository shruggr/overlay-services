import { TopicManager } from './TopicManager.js'
import { LookupService } from './LookupService.js'
import { Storage } from './storage/Storage.js'
import type { AdmittanceInstructions } from './AdmittanceInstructions.js'
import type { Output } from './Output.js'
import { TaggedBEEF } from './TaggedBEEF.js'
import { STEAK } from './STEAK.js'
import { LookupQuestion } from './LookupQuestion.js'
import { LookupAnswer } from './LookupAnswer.js'
import { LookupFormula } from './LookupFormula.js'
import { Transaction, ChainTracker, MerklePath, Broadcaster } from '@bsv/sdk'
import { Advertiser } from './Advertiser.js'
import { SHIPAdvertisement } from './SHIPAdvertisement.js'

/**
 * Am engine for running BSV Overlay Services (topic managers and lookup services).
 */
export class Engine {
  /**
   * Creates a new Overlay Services Engine
   * @param {[key: string]: TopicManager} managers - manages topic admittance
   * @param {[key: string]: LookupService} lookupServices - manages UTXO lookups
   * @param {Storage} storage - for interacting with internally-managed persistent data
   * @param {ChainTracker} chainTracker - Verifies SPV data associated with transactions
   * @param {string} hostingURL
   * @param {Broadcaster} [Broadcaster] - broadcaster used for broadcasting the incoming transaction
   * @param {Advertiser} [Advertiser] - handles SHIP and SLAP advertisements for peer-discovery
   * @param {string} shipTrackers - SHIP domains we know to bootstrap the system
   * @param {string} slapTrackers - SAP domains we know to bootstrap the system
   */
  constructor(
    public managers: { [key: string]: TopicManager },
    public lookupServices: { [key: string]: LookupService },
    public storage: Storage,
    public chainTracker: ChainTracker,
    public hostingURL: string,
    public shipTrackers?: string[],
    public slapTrackers?: string[],
    public broadcaster?: Broadcaster,
    public advertiser?: Advertiser
  ) { }

  /**
   * Submits a transaction for processing by Overlay Services.
   * @param {TaggedBEEF} taggedBEEF - The transaction to process
   * @param {function(STEAK): void} [onSTEAKReady] - Optional callback function invoked when the STEAK is ready.
   * 
   * The optional callback function should be used to get STEAK when ready, and avoid waiting for broadcast and transaction propagation to complete.
   * 
   * @returns {Promise<STEAK>} The submitted transaction execution acknowledgement
   */
  async submit(taggedBEEF: TaggedBEEF, onSteakReady?: (steak: STEAK) => void): Promise<STEAK> {
    for (const t of taggedBEEF.topics) {
      if (this.managers[t] === undefined || this.managers[t] === null) {
        throw new Error(`This server does not support this topic: ${t}`)
      }
    }
    // Validate the transaction SPV information
    const tx = Transaction.fromBEEF(taggedBEEF.beef)
    const txid = tx.id('hex')
    const txValid = await tx.verify(this.chainTracker)
    if (!txValid) throw new Error('Unable to verify SPV information.')

    // Find UTXOs belonging to a particular topic
    const steak: STEAK = {}
    for (const topic of taggedBEEF.topics) {
      // Ensure transaction is not already applied to the topic
      const dupeCheck = await this.storage.doesAppliedTransactionExist({
        txid,
        topic
      })
      if (dupeCheck) {
        // The transaction was already processed.
        // Currently, NO OUTPUTS ARE ADMITTED FOR DUPLICATE TRANSACTIONS.
        // An alternative decision, one that was decided against, would be to act as if the operation was successful: looking up and returning the list of admitted outputs from when the transaction was originally processed.
        // This was decided against, because we don't want to encourage unnecessary flooding of duplicative transactions to overlay services.
        steak[topic] = {
          outputsToAdmit: [],
          coinsToRetain: []
        }
        continue
      }

      // Check if any input of this transaction is a previous UTXO, adding previous UTXOs to the list
      const previousCoins: number[] = []
      for (const [i, input] of tx.inputs.entries()) {
        const previousTXID = input.sourceTXID || input.sourceTransaction?.id('hex') as string
        // Check if a previous UTXO exists in the storage medium
        const output = await this.storage.findOutput(
          previousTXID,
          input.sourceOutputIndex,
          topic
        )
        if (output !== undefined && output !== null) {
          previousCoins.push(i)

          // This output is now spent.
          await this.storage.markUTXOAsSpent(
            output.txid,
            output.outputIndex,
            topic
          )

          // Notify the lookup services about the spending of this output
          for (const l of Object.values(this.lookupServices)) {
            try {
              if (l.outputSpent !== undefined && l.outputSpent !== null) {
                await l.outputSpent(
                  output.txid,
                  output.outputIndex,
                  topic
                )
              }
            } catch (_) { }
          }
        }
      }

      // Use the manager to determine which outputs are admissable
      let admissableOutputs: AdmittanceInstructions
      try {
        admissableOutputs = await this.managers[topic].identifyAdmissibleOutputs(taggedBEEF.beef, previousCoins)
      } catch (_) {
        // If the topic manager throws an error, other topics may still succeed, so we continue to the next one.
        // No outputs were admitted to this topic in this case. Note, however, that the transaction is still valid according to Bitcoin, so it may have spent some previous overlay members. This is unavoidable and good.
        steak[topic] = {
          outputsToAdmit: [],
          coinsToRetain: []
        }
        continue
      }

      // Keep track of which outputs to admit, mark as stale, or retain
      const outputsToAdmit: number[] = admissableOutputs.outputsToAdmit
      const staleCoins: Array<{
        txid: string
        outputIndex: number
      }> = []
      const outputsConsumed: Array<{
        txid: string
        outputIndex: number
      }> = []

      // Find which outputs should not be retained and mark them as stale
      // For each of the previous UTXOs, if the the UTXO was not included in the list of UTXOs identified for retention, then it will be marked as stale.
      for (const inputIndex of previousCoins) {
        const previousTXID = tx.inputs[inputIndex].sourceTXID || tx.inputs[inputIndex].sourceTransaction?.id('hex') as string
        const previousOutputIndex = tx.inputs[inputIndex].sourceOutputIndex
        if (!admissableOutputs.coinsToRetain.includes(inputIndex)) {
          staleCoins.push({
            txid: previousTXID,
            outputIndex: previousOutputIndex
          })
        } else {
          outputsConsumed.push({
            txid: previousTXID,
            outputIndex: previousOutputIndex
          })
        }
      }

      // Remove stale outputs recursively
      for (const coin of staleCoins) {
        const output = await this.storage.findOutput(coin.txid, coin.outputIndex, topic)
        if (output !== undefined && output !== null) {
          await this.deleteUTXODeep(output)
        }
      }

      // Handle admittance and notification of incoming UTXOs
      const newUTXOs: Array<{ txid: string, outputIndex: number }> = []
      for (const outputIndex of outputsToAdmit) {
        // Store the output
        await this.storage.insertOutput({
          txid,
          outputIndex,
          outputScript: tx.outputs[outputIndex].lockingScript.toBinary(),
          satoshis: tx.outputs[outputIndex].satoshis as number,
          topic,
          spent: false,
          beef: taggedBEEF.beef,
          consumedBy: [],
          outputsConsumed
        })
        newUTXOs.push({
          txid,
          outputIndex
        })

        // Notify all the lookup services about the new UTXO
        for (const l of Object.values(this.lookupServices)) {
          try {
            if (l.outputAdded !== undefined && l.outputAdded !== null) {
              await l.outputAdded(txid, outputIndex, tx.outputs[outputIndex].lockingScript, topic)
            }
          } catch (_) { }
        }
      }

      // Update each output consumed to know who consumed it
      for (const output of outputsConsumed) {
        const outputToUpdate = await this.storage.findOutput(output.txid, output.outputIndex, topic)
        if (outputToUpdate !== undefined && outputToUpdate !== null) {
          const newConsumedBy = [...new Set([...newUTXOs, ...outputToUpdate.consumedBy])]
          // Note: only update if newConsumedBy !== new Set(JSON.parse(outputToUpdate.consumedBy)) ?
          await this.storage.updateConsumedBy(output.txid, output.outputIndex, topic, newConsumedBy)
        }
      }

      // Insert the applied transaction to prevent duplicate processing
      await this.storage.insertAppliedTransaction({
        txid,
        topic
      })

      // Keep track of what outputs were admitted for what topic
      steak[topic] = admissableOutputs
    }

    // Call the callback function if it is provided
    if (onSteakReady) {
      onSteakReady(steak)
    }

    // Broadcast the transaction
    if (Object.keys(steak).length > 0 && this.broadcaster !== undefined) {
      await this.broadcaster.broadcast(tx)
    }

    // If we don't have an advertiser, just return the steak
    if (this.advertiser === undefined) {
      return steak
    }

    // Propagate transaction to other nodes according to synchronization agreements
    // 1. Find nodes that host the topics associated with admissable outputs
    // We want to figure out which topics we actually care about (because their associated outputs were admitted)
    // AND if the topic was not admitted we want to remove it from the list of topics we care about.
    const relevantTopics = taggedBEEF.topics.filter(topic =>
      steak[topic] !== undefined && steak[topic].outputsToAdmit.length !== 0
    )

    if (relevantTopics.length > 0) {
      // Find all SHIP advertisements for the topics we care about
      const domainToTopicsMap = new Map<string, Set<string>>()
      for (const topic of relevantTopics) {
        try {
          // Handle custom lookup service answers
          const lookupAnswer = await this.lookup({
            service: 'ls_ship',
            query: {
              topic
            }
          })

          // Lookup will currently always return type output-list
          if (lookupAnswer.type === 'output-list') {
            const shipAdvertisements: SHIPAdvertisement[] = []
            lookupAnswer.outputs.forEach(output => {
              try {
                // Parse out the advertisements using the provided parser
                const tx = Transaction.fromBEEF(output.beef)
                const advertisement = this.advertiser?.parseAdvertisement(tx.outputs[output.outputIndex].lockingScript)
                if (advertisement !== undefined && advertisement !== null && advertisement.protocol === 'SHIP') {
                  shipAdvertisements.push(advertisement)
                }
              } catch (error) {
                console.error('Failed to parse advertisement output:', error)
              }
            })
            if (shipAdvertisements.length > 0) {
              shipAdvertisements.forEach((advertisement: SHIPAdvertisement) => {
                if (!domainToTopicsMap.has(advertisement.domain)) {
                  domainToTopicsMap.set(advertisement.domain, new Set<string>())
                }
                domainToTopicsMap.get(advertisement.domain)?.add(topic)
              })
            }
          }
        } catch (error) {
          console.error(`Error looking up topic ${String(topic)}:`, error)
        }
      }

      const broadcastPromises: Array<Promise<Response>> = []

      // Make sure we gossip to the shipTrackers we know about.
      if (this.shipTrackers !== undefined && this.shipTrackers.length !== 0 && relevantTopics.includes('tm_ship')) {
        this.shipTrackers.forEach(tracker => {
          if (domainToTopicsMap.get(tracker) !== undefined) {
            domainToTopicsMap.get(tracker)?.add('tm_ship')
          } else {
            domainToTopicsMap.set(tracker, new Set(['tm_ship']))
          }
        })
      }

      // Make sure we gossip to the slapTrackers we know about.
      if (this.slapTrackers !== undefined && this.slapTrackers.length !== 0 && relevantTopics.includes('tm_slap')) {
        this.slapTrackers.forEach(tracker => {
          if (domainToTopicsMap.get(tracker) !== undefined) {
            domainToTopicsMap.get(tracker)?.add('tm_slap')
          } else {
            domainToTopicsMap.set(tracker, new Set<string>(['tm_slap']))
          }
        })
      }

      // Note: We are depending on window.fetch, this may not be ideal for the long term.
      for (const [domain, topics] of domainToTopicsMap.entries()) {
        if (domain !== this.hostingURL) {
          const promise = fetch(`${String(domain)}/submit`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Topics': JSON.stringify(Array.from(topics))
            },
            body: new Uint8Array(taggedBEEF.beef)
          })
          broadcastPromises.push(promise)
        }
      }

      try {
        await Promise.all(broadcastPromises)
      } catch (error) {
        console.error('Error during broadcasting:', error)
      }
    }

    // Immediately return from the function without waiting for the promises to resolve.
    return steak
  }

  /**
   * Submit a lookup question to the Overlay Services Engine, and receive bakc a Lookup Answer
   * @param LookupQuestion — The question to ask the Overlay Services Engine
   * @returns The answer to the question
   */
  async lookup(lookupQuestion: LookupQuestion): Promise<LookupAnswer> {
    // Validate a lookup service for the provider is found
    const lookupService = this.lookupServices[lookupQuestion.service]
    if (lookupService === undefined || lookupService === null) throw new Error(`Lookup service not found for provider: ${lookupQuestion.service}`)

    let lookupResult = await lookupService.lookup(lookupQuestion)
    // Handle custom lookup service answers
    if ((lookupResult as LookupAnswer).type === 'freeform' || (lookupResult as LookupAnswer).type === 'output-list') {
      return lookupResult as LookupAnswer
    }
    lookupResult = lookupResult as LookupFormula

    const hydratedOutputs: Array<{ beef: number[], outputIndex: number }> = []

    for (const { txid, outputIndex, history } of lookupResult) {
      // Make sure this is an unspent output (UTXO)
      const UTXO = await this.storage.findOutput(
        txid,
        outputIndex,
        undefined,
        false
      )
      if (UTXO === undefined || UTXO === null) continue

      // Get the history for this utxo and construct a BRC-8 Envelope
      const output = await this.getUTXOHistory(UTXO, history, 0)
      if (output !== undefined && output !== null) {
        hydratedOutputs.push({
          beef: output.beef,
          outputIndex: output.outputIndex
        })
      }
    }
    return {
      type: 'output-list',
      outputs: hydratedOutputs
    }
  }

  /**
   * Ensures alignment between the current SHIP/SLAP advertisements and the 
   * configured Topic Managers and Lookup Services in the engine.
   *
   * This method performs the following actions:
   * 1. Retrieves the current configuration of topics and services.
   * 2. Fetches the existing SHIP advertisements for each configured topic.
   * 3. Fetches the existing SLAP advertisements for each configured service.
   * 4. Compares the current configuration with the fetched advertisements to determine which advertisements
   *    need to be created or revoked.
   * 5. Creates new SHIP/SLAP advertisements if they do not exist for the configured topics/services.
   * 6. Revokes existing SHIP/SLAP advertisements if they are no longer required based on the current configuration.
   *
   * The function uses the `Advertiser` methods to create or revoke advertisements and ensures the updates are
   * submitted to the SHIP/SLAP overlay networks using the engine's `submit()` method.
   *
   * @throws Will throw an error if there are issues during the advertisement synchronization process.
   * @returns {Promise<void>} A promise that resolves when the synchronization process is complete.
   */
  async syncAdvertisements(): Promise<void> {
    if (this.advertiser === undefined) {
      return
    }
    const advertiser = this.advertiser

    // Step 1: Retrieve Current Configuration
    const configuredTopics = Object.keys(this.managers)
    const configuredServices = Object.keys(this.lookupServices)

    // Step 2: Fetch Existing Advertisements
    const currentSHIPAdvertisements = await advertiser.findAllSHIPAdvertisements()
    const currentSLAPAdvertisements = await advertiser.findAllSLAPAdvertisements()

    // Step 3: Compare and Determine Actions
    const requiredSHIPAdvertisements = new Set(configuredTopics)
    const requiredSLAPAdvertisements = new Set(configuredServices)

    const existingSHIPTopics = new Set(currentSHIPAdvertisements.map(ad => ad.topic))
    const existingSLAPServices = new Set(currentSLAPAdvertisements.map(ad => ad.service))

    const shipToCreate = Array.from(requiredSHIPAdvertisements).filter(topic => !existingSHIPTopics.has(topic))
    const shipToRevoke = currentSHIPAdvertisements.filter(ad => !requiredSHIPAdvertisements.has(ad.topic))

    const slapToCreate = Array.from(requiredSLAPAdvertisements).filter(service => !existingSLAPServices.has(service))
    const slapToRevoke = currentSLAPAdvertisements.filter(ad => !requiredSLAPAdvertisements.has(ad.service))

    // Step 4: Update Advertisements
    for (const topic of shipToCreate) {
      try {
        const taggedBEEF = await advertiser.createSHIPAdvertisement(topic)
        await this.submit(taggedBEEF)
      } catch (error) {
        console.error('Failed to create SHIP advertisement:', error)
      }
    }

    for (const service of slapToCreate) {
      try {
        const taggedBEEF = await advertiser.createSLAPAdvertisement(service)
        await this.submit(taggedBEEF)
      } catch (error) {
        console.error('Failed to create SLAP advertisement:', error)
      }
    }

    for (const ad of shipToRevoke) {
      try {
        const taggedBEEF = await advertiser.revokeAdvertisement(ad)
        await this.submit(taggedBEEF)
      } catch (error) {
        console.error('Failed to revoke SHIP advertisement:', error)
      }
    }

    for (const ad of slapToRevoke) {
      try {
        const taggedBEEF = await advertiser.revokeAdvertisement(ad)
        await this.submit(taggedBEEF)
      } catch (error) {
        console.error('Failed to revoke SLAP advertisement:', error)
      }
    }
  }

  /**
   * Traverse and return the history of a UTXO.
   *
   * This method traverses the history of a given Unspent Transaction Output (UTXO) and returns
   * its historical data based on the provided history selector and current depth.
   *
   * @param output - The UTXO to traverse the history for.
   * @param historySelector - Optionally directs the history traversal:
   *  - If a number, denotes how many previous spends (in terms of chain depth) to include.
   *  - If a function, accepts a BEEF-formatted transaction, an output index, and the current depth as parameters,
   *    returning a promise that resolves to a boolean indicating whether to include the output in the history.
   * @param {number} [currentDepth=0] - The current depth of the traversal relative to the top-level UTXO.
   *
   * @returns {Promise<Output | undefined>} - A promise that resolves to the output history if found, or undefined if not.
   */
  async getUTXOHistory(
    output: Output,
    historySelector?: ((beef: number[], outputIndex: number, currentDepth: number) => Promise<boolean>) | number,
    currentDepth = 0
  ): Promise<Output | undefined> {
    // If we have an output but no history selector, jsut return the output.
    if (typeof historySelector === 'undefined') {
      return output
    }

    // Determine if history traversal should continue for the current node
    let shouldTraverseHistory
    if (typeof historySelector !== 'number') {
      shouldTraverseHistory = await historySelector(output.beef, output.outputIndex, currentDepth)
    } else {
      shouldTraverseHistory = currentDepth <= historySelector
    }

    if (shouldTraverseHistory === false) {
      return undefined
    } else if (output !== null && output !== undefined && output.outputsConsumed.length === 0) {
      return output
    }

    try {
      // Query the storage engine for UTXOs consumed by this UTXO
      // Only retrieve unique values in case outputs are doubly referenced
      const outputsConsumed: Array<{ txid: string, outputIndex: number }> = output.outputsConsumed

      // Find the child outputs for each utxo consumed by the current output
      const childHistories = (await Promise.all(
        outputsConsumed.map(async (outputIdentifier) => {
          const output = await this.storage.findOutput(outputIdentifier.txid, outputIdentifier.outputIndex)

          // Make sure an output was found
          if (output === undefined || output === null) {
            return undefined
          }

          // Find previousUTXO history
          return await this.getUTXOHistory(output, historySelector, currentDepth + 1)
        })
      )).filter(x => x !== undefined)

      const tx = Transaction.fromBEEF(output.beef)
      for (const input of childHistories) {
        if (input === undefined || input === null) continue
        const inputIndex = tx.inputs.findIndex((input) => {
          const sourceTXID = input.sourceTXID !== undefined && input.sourceTXID !== ''
            ? input.sourceTXID
            : input.sourceTransaction?.id('hex')
          return sourceTXID === output.txid && input.sourceOutputIndex === output.outputIndex
        })
        tx.inputs[inputIndex].sourceTransaction = Transaction.fromBEEF(input.beef)
      }
      const beef = tx.toBEEF()
      return {
        ...output,
        beef
      }
    } catch (e) {
      // Handle any errors that occurred
      // Note: Test this!
      console.error(`Error retrieving UTXO history: ${e}`)
      // return []
      throw new Error(`Error retrieving UTXO history: ${e}`)
    }
  }

  /**
   * Delete a UTXO and all stale consumed inputs.
   * @param output - The UTXO to be deleted.
   * @returns {Promise<void>} - A promise that resolves when the deletion process is complete.
   */
  private async deleteUTXODeep(output: Output): Promise<void> {
    try {
      // Delete the current output IFF there are no references to it
      if (output.consumedBy.length === 0) {
        await this.storage.deleteOutput(output.txid, output.outputIndex, output.topic)

        // Notify the lookup services of the UTXO being deleted
        for (const l of Object.values(this.lookupServices)) {
          try {
            await l.outputDeleted?.(
              output.txid,
              output.outputIndex,
              output.topic
            )
          } catch (_) { }
        }
      }

      // If there are no more consumed utxos, return
      if (output.outputsConsumed.length === 0) {
        return
      }

      // Delete any stale outputs that were consumed as inputs
      output.outputsConsumed.map(async (outputIdentifier) => {
        const staleOutput = await this.storage.findOutput(outputIdentifier.txid, outputIdentifier.outputIndex, output.topic)

        // Make sure an output was found
        if (staleOutput === null || staleOutput === undefined) {
          return undefined
        }

        // Parse out the existing data, then concat the new outputs with no duplicates
        if (staleOutput.consumedBy.length !== 0) {
          staleOutput.consumedBy = staleOutput.consumedBy.filter(x => x.txid !== output.txid && x.outputIndex !== output.outputIndex)
          // Update with the new consumedBy data
          await this.storage.updateConsumedBy(outputIdentifier.txid, outputIdentifier.outputIndex, output.topic, staleOutput.consumedBy)
        }

        // Find previousUTXO history
        return await this.deleteUTXODeep(staleOutput)
      })
    } catch (error) {
      throw new Error(`Failed to delete all stale outputs: ${error as string}`)
    }
  }

  /**
   * Recursively updates the Merkle proof for the given output and its consumedBy outputs.
   * If the output matches the source transaction ID, its Merkle proof is updated directly.
   * Otherwise, the Merkle proof is updated for the corresponding input in each transaction.
   *
   * @param output - The output to update with the new Merkle proof.
   * @param proof - The Merkle proof to be applied to the output or its inputs.
   * @param sourceTxid - The transaction ID of the source output whose Merkle proof is being updated.
   */
  private async updateMerkleProof(output: Output, proof: MerklePath, recursionPath: Array<{ txid: string, outputIndex: number }>): Promise<void> {
    // Add current output to recursionPath
    recursionPath.push({ txid: output.txid, outputIndex: output.outputIndex })

    const tx = Transaction.fromBEEF(output.beef)

    // Handle the base case
    if (output.txid === recursionPath[0].txid) {
      tx.merklePath = proof
    } else {
      // Traverse inputs to update the Merkle proof according to the recursionPath
      let currentInputs = tx.inputs

      for (let i = recursionPath.length - 1; i >= 0; i--) {
        const crumb = recursionPath[i]

        for (const input of currentInputs) {
          if (input.sourceTXID === crumb.txid && input.sourceOutputIndex === crumb.outputIndex) {
            if (i === 0 && input.sourceTransaction !== undefined) {
              input.sourceTransaction.merklePath = proof
            } else if (input.sourceTransaction !== undefined) {
              currentInputs = input.sourceTransaction.inputs
              break
            }
          }
        }
      }
    }

    // Update the output's BEEF in the storage DB
    await this.storage.updateOutputBeef(output.txid, output.outputIndex, output.topic, tx.toBEEF())

    // Recursively update the consumedBy outputs
    for (const consumingOutput of output.consumedBy) {
      const consumedOutputs = await this.storage.findOutputsForTransaction(consumingOutput.txid)
      for (const consumedOutput of consumedOutputs) {
        await this.updateMerkleProof(consumedOutput, proof, [])
      }
    }
  }

  /**
   * Recursively prune UTXOs when an incoming Merkle Proof is received.
   *
   * @param txid - Transaction ID of the associated outputs to prune.
   * @param proof - Merkle proof containing the Merkle path and other relevant data to verify the transaction.
   */
  async handleNewMerkleProof(txid: string, proof: MerklePath): Promise<void> {
    const outputs = await this.storage.findOutputsForTransaction(txid)

    if (outputs == undefined || outputs.length === 0) {
      throw new Error('Could not find matching transaction outputs for proof ingest!')
    }

    for (const output of outputs) {
      await this.updateMerkleProof(output, proof, [])
    }
  }

  /**
   * Find a list of supported topic managers
   * @public
   * @returns {Promise<string[]>} - array of supported topic managers
   */
  async listTopicManagers(): Promise<string[]> {
    return Object.keys(this.managers)
  }

  /**
   * Find a list of supported lookup services
   * @public
   * @returns {Promise<string[]>} - array of supported lookup services
   */
  async listLookupServiceProviders(): Promise<string[]> {
    return Object.keys(this.lookupServices)
  }

  /**
   * Run a query to get the documentation for a particular topic manager
   * @public
   * @returns {Promise<string>} - the documentation for the topic manager
   */
  async getDocumentationForTopicManager(manager: any): Promise<string> {
    const documentation = await this.managers[manager]?.getDocumentation?.()
    return documentation !== undefined ? documentation : 'No documentation found!'
  }

  /**
   * Run a query to get the documentation for a particular lookup service
   * @public
   * @returns {Promise<string>} -  the documentation for the lookup service
   */
  async getDocumentationForLookupServiceProvider(provider: any): Promise<string> {
    const documentation = await this.lookupServices[provider]?.getDocumentation?.()
    return documentation !== undefined ? documentation : 'No documentation found!'
  }
}
