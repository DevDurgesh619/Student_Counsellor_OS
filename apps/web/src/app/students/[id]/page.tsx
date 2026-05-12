import { redirect } from 'next/navigation';

export default function StudentRoot({ params }: { params: { id: string } }) {
  redirect(`/students/${params.id}/today`);
}
