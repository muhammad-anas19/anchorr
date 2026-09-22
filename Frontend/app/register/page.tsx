import { RegisterForm } from '../../features/auth/RegisterForm';
import { AuthLayout } from '../../shared/ui/AuthLayout';

export default function RegisterPage() {
  return (
    <AuthLayout title="Create your workspace">
      <RegisterForm />
    </AuthLayout>
  );
}
