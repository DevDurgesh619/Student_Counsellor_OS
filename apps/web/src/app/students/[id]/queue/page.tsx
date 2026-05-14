'use client';

import { useParams } from 'next/navigation';
import { QueueView } from '@/components/queue-view';

export default function StudentQueuePage() {
  const { id } = useParams<{ id: string }>();
  return <QueueView studentId={id} />;
}
