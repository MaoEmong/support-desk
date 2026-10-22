'use client';
import { useParams } from 'next/navigation';
import { TicketDetail } from '@/components/admin/ticket-detail';
export default function Page() { const { id } = useParams<{id:string}>(); return <TicketDetail key={id} id={id} />; }
