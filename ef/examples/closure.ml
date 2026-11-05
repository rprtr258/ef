add = lambda x y -> x + y

closure = lambda x -> do
  adder = lambda y -> add(x, y);
  adder
end

main = lambda -> do
  add3 = closure(3);
  print(add3(4))
end
