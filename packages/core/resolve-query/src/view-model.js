const createViewModel = ({
  projection,
  eventStore,
  snapshotAdapter = null,
  invariantHash = null,
  serializeState
}) => {
  const getKey = aggregateIds =>
    Array.isArray(aggregateIds) ? aggregateIds.sort().join(',') : aggregateIds
  const viewMap = new Map()

  if (
    (invariantHash == null || invariantHash.constructor !== String) &&
    snapshotAdapter != null
  ) {
    throw new Error(
      `Field 'invariantHash' is mandatory when using view-model snapshots`
    )
  }

  const reader = async ({ aggregateIds } = { aggregateIds: null }) => {
    if (
      aggregateIds !== '*' &&
      (!Array.isArray(aggregateIds) || aggregateIds.length === 0)
    ) {
      throw new Error(
        'View models are build up only with aggregateIds array or wildcard argument'
      )
    }

    const key = getKey(aggregateIds)
    if (viewMap.has(key)) {
      const viewModel = viewMap.get(key)
      return await viewModel.read()
    }

    const snapshotKey = `${invariantHash};${key}`
    const eventTypes = Object.keys(projection).filter(
      eventName => eventName !== 'Init'
    )

    let lastTimestamp = -1
    let lastError = null
    let state = null

    try {
      const snapshot = await snapshotAdapter.loadSnapshot(snapshotKey)
      lastTimestamp = snapshot.timestamp
      state = snapshot.state
    } catch (error) {}

    try {
      if (!(+lastTimestamp > 0) && typeof projection.Init === 'function') {
        state = projection.Init()
      }
    } catch (error) {
      lastError = error
    }

    const regularHandler = event => {
      if (!event || !event.type || lastError) return
      try {
        state = projection[event.type](state, event)
      } catch (error) {
        lastError = error
      }
    }

    const snapshotHandler = event => {
      if (!event || !event.type || lastError) return
      try {
        state = projection[event.type](state, event)
        lastTimestamp = event.timestamp - 1
        snapshotAdapter.saveSnapshot(snapshotKey, {
          lastTimestamp,
          state
        })
      } catch (error) {
        lastError = error
      }
    }

    const handler = snapshotAdapter != null ? snapshotHandler : regularHandler

    const subscribePromise =
      aggregateIds === '*'
        ? eventStore.subscribeByEventType(eventTypes, handler, {
            onlyBus: false,
            startTime: lastTimestamp
          })
        : eventStore.subscribeByAggregateId(
            aggregateIds,
            event => eventTypes.includes(event.type) && handler(event),
            { onlyBus: false, startTime: lastTimestamp }
          )

    const read = async () => {
      await subscribePromise
      return state
    }

    const getLastError = async () => {
      await subscribePromise
      return lastError
    }

    const dispose = () => {
      subscribePromise.then(unsubscribe => unsubscribe())
    }

    viewMap.set(key, {
      read,
      getLastError,
      dispose
    })

    return await read()
  }

  const dispose = aggregateIds => {
    if (!aggregateIds) {
      viewMap.forEach(({ dispose }) => dispose())
      viewMap.clear()
      return
    }

    const key = getKey(aggregateIds)
    if (!viewMap.has(key)) {
      return
    }

    viewMap.get(key).dispose()
    viewMap.delete(key)
  }

  return Object.freeze({
    read: reader,

    readAndSerialize: async ({ jwtToken, ...args }) => {
      const state = await reader(args)
      const serializedState = serializeState(state, jwtToken)
      return serializedState
    },

    getLastError: async ({ aggregateIds } = { aggregateIds: null }) => {
      const key = getKey(aggregateIds)
      if (!viewMap.has(key)) {
        return null
      }

      const viewModel = viewMap.get(key)
      return await viewModel.getLastError()
    },

    dispose
  })
}

export default createViewModel
