import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import PublicWrapper from '#app/components/public-wrapper';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#app/components/ui/card';

export const meta: MetaFunction = () => {
  return [{ title: 'Register' }];
};

export default function Register() {
  return (
    <PublicWrapper>
      <main className="flex min-h-[60vh] items-center justify-center">
        <div className="w-full max-w-sm">
          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-xl">Create an Account</CardTitle>
              <CardDescription>
                Registration is currently invite-only
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center">
              <p className="text-sm text-muted-foreground mb-4">
                Please contact your organization administrator for an invitation.
              </p>
              <Link
                to="/login"
                className="text-sm underline underline-offset-4 hover:text-primary"
              >
                Back to login
              </Link>
            </CardContent>
          </Card>
        </div>
      </main>
    </PublicWrapper>
  );
}
