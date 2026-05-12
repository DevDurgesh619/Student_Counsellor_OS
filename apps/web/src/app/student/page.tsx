import { redirect } from 'next/navigation';

export default function StudentRoot() {
  redirect('/student/today');
}
