'use client';

import { useParams } from 'next/navigation';
import { TodosView } from '@/components/todos-view';

export default function StudentTodosPage() {
  const { id } = useParams<{ id: string }>();
  return <TodosView studentId={id} />;
}
