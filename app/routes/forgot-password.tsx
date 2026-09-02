import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import PublicWrapper from '#app/components/public-wrapper';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#app/components/ui/card';

export const meta: MetaFunction = () => {
  return [{ title: 'Forgot Password' }];
};

export default function ForgotPassword() {
  return (
    <PublicWrapper>
      <main className="flex min-h-[60vh] items-center justify-center">
        <div className="w-full max-w-sm">
          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-xl">Forgot Password</CardTitle>
              <CardDescription>
                Password reset functionality coming soon
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center">
              <p className="text-sm text-muted-foreground mb-4">
                Please contact your administrator to reset your password.
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
