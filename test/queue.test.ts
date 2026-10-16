import assert from 'node:assert/strict'
import test from 'node:test'
import { CheckQueue } from '../src/queue.js'
import { failure } from '../src/probe.js'

test('bounded queue deduplicates accounts, enforces capacity and frees cancelled slots', async () => {
  const releases: (() => void)[] = []
  const queue = new CheckQueue(1, 1, async () => {
    await new Promise<void>(resolve => releases.push(resolve))
    return failure('test result')
  })
  const first = queue.enqueue(1)
  const second = queue.enqueue(2)
  assert.equal(queue.enqueue(1), first)
  assert.equal(queue.enqueue(2), second)
  assert.throws(() => queue.enqueue(3), /队列已满/)
  assert.equal(queue.state().active, 1)
  assert.equal(queue.state().queued, 1)
  assert.equal(queue.state().dropped, 1)
  assert.equal(queue.cancel(2), true)
  assert.equal(second.status, 'cancelled')
  const third = queue.enqueue(3)
  await new Promise(resolve => setImmediate(resolve))
  releases.shift()!()
  for (let i = 0; i < 100 && third.status !== 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(third.status, 'running')
  releases.shift()!()
  await queue.close()
  assert.equal(queue.state().active, 0)
})

test('closing the queue aborts active work and cancels queued work', async () => {
  const queue = new CheckQueue(1, 2, async (_id, signal) => {
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) reject(new Error('aborted'))
      else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    return failure('never')
  })
  const first = queue.enqueue(1), second = queue.enqueue(2)
  await queue.close()
  assert.equal(first.status, 'cancelled')
  assert.equal(second.status, 'cancelled')
  assert.throws(() => queue.enqueue(3), /已停止/)
})
