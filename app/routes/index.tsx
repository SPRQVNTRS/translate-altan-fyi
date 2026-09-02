import type { MetaFunction } from "react-router";
import { Link } from "react-router";
import PublicWrapper from "#app/components/public-wrapper";
import { useOptionalUser } from '#app/hooks/use-user';

export const meta: MetaFunction = () => [
  { title: "Welcome" },
  { name: "description", content: "Public home" },
];

export default function Index() {
  const user = useOptionalUser();

  return (
    <PublicWrapper>
      <h1 className="text-3xl font-bold mb-4">Welcome</h1>
      <p className="text-muted-foreground mb-8">
        {user
          ? `Welcome back, ${user.name}! Go to your dashboard to manage your site.`
          : 'Sign in to manage your site.'}
      </p>
      <div className="flex gap-4">
        {user ? (
          <Link
            to="/dashboard"
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90"
          >
            Go to Dashboard
          </Link>
        ) : (
          <Link
            to="/login"
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90"
          >
            Login
          </Link>
        )}
      </div>
    </PublicWrapper>
  );
}
