import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex max-w-4xl flex-col gap-10" aria-busy="true" aria-label="Loading your money">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-14 w-72" />
      </div>
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-52 w-full" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
