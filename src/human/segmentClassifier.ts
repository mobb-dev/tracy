import { Segment } from './segmenter'
import { SegmentClassification, SegmentClassificationCode } from './types'

export async function classifySegment(
  _segment: Segment
): Promise<SegmentClassificationCode> {
  //this is future preparation for more complex classification logic - for now we rely solely on the event classifier
  return SegmentClassification.HUMAN_POSITIVE
}
