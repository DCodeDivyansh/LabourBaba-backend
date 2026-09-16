import prisma from "../config/prisma";
import { CreateCustomerReq } from "../type/api_req.type";
import { Customer } from "../type/api_res.types";
import { hashPassword } from "../utils/authUtils";
import { customerPublicSelect, toCustomerPublicDTO } from "./prismaSelects";

export const getAll = async (): Promise<Customer[]> => {
  const clients = await prisma.customer.findMany({
    select: customerPublicSelect,
  });
  return clients.map(toCustomerPublicDTO) as Customer[];
};

export const customerService = async (data: CreateCustomerReq): Promise<Customer> => {
  const tempPassword = Math.random().toString(36).slice(-8);
  const hashedPassword = await hashPassword(tempPassword);
  const created = await prisma.customer.create({
    data: {
      ...data,
      password: hashedPassword,
    },
    select: customerPublicSelect,
  });
  return toCustomerPublicDTO(created) as Customer;
};

