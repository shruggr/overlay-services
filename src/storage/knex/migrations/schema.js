exports.up = async knex => {
  await knex.schema.createTable('outputs', table => {
    table.increments()
    table.string('txid', 64)
    table.integer('outputIndex', 10)
    table.binary('outputScript')
    table.string('topic')
    table.integer('satoshis', 15)
    table.text('rawTx', 'longtext')
    table.text('proof', 'longtext')
    table.text('mapiResponses', 'longtext')
    table.text('inputs', 'longtext')
    // Represents the outputs that were provided as inputs
    // to the transaction that created this output.
    // This indicates the correct history of this output.
    table.text('utxosConsumed', 'longtext').defaultTo('[]')
    // Tracks any outputs the current output is used as an input in it's creation
    table.text('consumedBy', 'longtext').defaultTo('[]')
    table.boolean('spent').defaultTo(false)
  })
  await knex.schema.createTable('applied_transactions', table => {
    table.increments()
    table.string('txid', 64)
    table.string('topic')
  })
}

exports.down = async knex => {
  await knex.schema.dropTable('applied_transactions')
  await knex.schema.dropTable('outputs')
}
