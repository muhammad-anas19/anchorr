import { LoginForm } from '../../features/auth/LoginForm';
import { AuthLayout } from '../../shared/ui/AuthLayout';

export default function LoginPage() {
  return (
    <AuthLayout title="Anchor Console">
      <LoginForm />
    </AuthLayout>
  );
}
