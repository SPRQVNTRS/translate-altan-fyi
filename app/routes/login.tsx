import type { SubmissionResult } from '@conform-to/react';
import type { Route } from './+types/login';
import type { MetaFunction } from 'react-router';
import { getFormProps, getInputProps, useForm } from '@conform-to/react';
import { parseWithZod } from '@conform-to/zod/v4';
import { authenticator } from '#app/services/auth.server';
import { sessionStorage } from '#app/services/session.server';
import { Form, redirect, useActionData, Link } from 'react-router';
import { z } from 'zod';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#app/components/ui/card';
import PublicWrapper from '#app/components/public-wrapper';
import { useFormField } from '#app/hooks/use-form-field';

export const meta: MetaFunction = () => {
  return [{ title: 'Login' }];
};

const schema = z.object({
  email: z.email(),
  password: z.string(),
  remember: z.boolean().optional(),
});

export const handle = {
  title: 'Login',
};

export async function action({ request }: Route.ActionArgs) {
  const clonedRequest = request.clone();
  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema });

  if (submission.status !== 'success') {
    return submission.reply();
  }

  try {
    const user = await authenticator.authenticate('user-pass', clonedRequest);
    const session = await sessionStorage.getSession(clonedRequest.headers.get('cookie'));
    session.set('user', user);

    // Redirect to dashboard (shows user's orgs)
    const redirectTo = '/dashboard';

    return redirect(redirectTo, {
      headers: { 'Set-Cookie': await sessionStorage.commitSession(session) },
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message === 'Account Deactivated'
        ? 'Your account has been deactivated. Please contact support.'
        : 'Invalid email or password';

    return {
      status: 'error',
      error: {
        'login-error': [message],
      },
    } satisfies SubmissionResult;
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  const user = session.get('user');

  if (user) {
    // Redirect to dashboard
    throw redirect('/dashboard');
  }

  return null;
}

export default function Index() {
  const lastResult = useActionData<typeof action>();
  const [persistedEmail, setPersistedEmail] = useFormField('login', 'email', '');
  const [form, fields] = useForm({
    lastResult,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema });
    },
    shouldValidate: 'onBlur',
    defaultValue: {
      email: persistedEmail,
    },
  });

  return (
    <PublicWrapper>
      <main className="flex min-h-[60vh] items-center justify-center">
        <div className="w-full max-w-sm">
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader className="text-center">
                <CardTitle className="text-xl">Welcome back</CardTitle>
                <CardDescription>Login with your Apple or Google account</CardDescription>
              </CardHeader>
              <CardContent>
                <Form method="post" {...getFormProps(form)} onChange={(event) => {
                  // Read the field off the form itself rather than narrowing
                  // the event target, which is only typed as an EventTarget.
                  const email = z
                    .string()
                    .safeParse(new FormData(event.currentTarget).get(fields.email.name));
                  if (email.success) setPersistedEmail(email.data);
                }}>
                  <div className="grid gap-6">
                    <div className="flex flex-col gap-4">
                      <Button type="button" variant="outline" className="w-full" disabled>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="mr-2 h-4 w-4">
                        <path
                          d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"
                          fill="currentColor"
                        />
                      </svg>
                      Login with Apple
                    </Button>
                    <Button type="button" variant="outline" className="w-full" disabled>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="mr-2 h-4 w-4">
                        <path
                          d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
                          fill="currentColor"
                        />
                      </svg>
                      Login with Google
                    </Button>
                    </div>
                    <div className="relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t after:border-border">
                      <span className="relative z-10 bg-background px-2 text-muted-foreground">Or continue with</span>
                    </div>
                    {lastResult?.error && (
                      <div className="text-sm text-red-500 text-center">{lastResult?.error['login-error']}</div>
                    )}
                    <div className="grid gap-6">
                      <div className="grid gap-2">
                        <Label htmlFor={fields.email.id}>Email</Label>
                        <Input
                        {...getInputProps(fields.email, { type: 'email' })}
                        placeholder="m@example.com"
                        className={!fields.email.valid ? 'border-red-500' : ''}
                        />
                        {fields.email.errors && <p className="text-sm text-red-500">{fields.email.errors}</p>}
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor={fields.password.id}>Password</Label>
                        <Input
                        {...getInputProps(fields.password, { type: 'password' })}
                        className={!fields.password.valid ? 'border-red-500' : ''}
                        />
                        {fields.password.errors && <p className="text-sm text-red-500">{fields.password.errors}</p>}
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                        <input
                          {...getInputProps(fields.remember, { type: 'checkbox' })}
                          className="h-4 w-4 rounded border-input bg-background accent-primary"
                        />
                        <Label htmlFor={fields.remember.id} className="text-sm font-normal">
                          Remember me
                        </Label>
                        </div>
                        <Link to="/forgot-password" className="text-sm underline-offset-4 hover:underline">
                          Forgot password?
                        </Link>
                      </div>
                      <Button type="submit" className="w-full">
                        Login
                      </Button>
                    </div>
                    <div className="text-center text-sm">
                      Don&apos;t have an account?{' '}
                      <Link to="/register" className="underline underline-offset-4">
                        Sign up
                      </Link>
                    </div>
                  </div>
                </Form>
              </CardContent>
            </Card>
            <div className="text-balance text-center text-xs text-muted-foreground [&_a]:underline [&_a]:underline-offset-4 [&_a]:hover:text-primary">
              By clicking continue, you agree to our <Link to="/terms">Terms of Service</Link> and{' '}
              <Link to="/privacy">Privacy Policy</Link>.
            </div>
          </div>
        </div>
      </main>
    </PublicWrapper>
  );
}
